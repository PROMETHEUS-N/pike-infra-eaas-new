'use strict';
// Runs inside the deploy job (actions/github-script) after azure/login, against the subscription of
// the selected GitHub Environment. For VM and PostgreSQL plan entries it:
//   - "auto" or empty size/SKU variable -> picks the lowest-cost SKU that this subscription can use in
//     the target region (not restricted, matches the image generation and CPU architecture, meets the
//     minimum vCPU / memory, and fits the remaining vCPU quota);
//   - explicit value -> checks that it is available; if not, the entry fails before deployment with
//     the cheapest available alternatives in the message.
// Chosen values are moved from entry.variables to entry.values, so the deploy action, the run
// summary and the inventory CSV all show the SKU that was actually used.
// VM prices: Azure Retail Prices API (public, pay-as-you-go, Linux or Windows meters).
// PostgreSQL: ordered by tier (Burstable < GeneralPurpose < MemoryOptimized), then vCores, then memory.

const PRICE_API = 'https://prices.azure.com/api/retail/prices';

const VM_DEFAULTS = {
  vmLinux: { os: 'linux', minMemVar: 'VM_LINUX_MIN_MEMORY_GB', minMem: 0.5, minCpuVar: 'VM_LINUX_MIN_VCPUS', minCpu: 1 },
  vmWindows: { os: 'windows', minMemVar: 'VM_WINDOWS_MIN_MEMORY_GB', minMem: 2, minCpuVar: 'VM_WINDOWS_MIN_VCPUS', minCpu: 1 },
  vmWindowsSql: { os: 'windows', minMemVar: 'VM_WINDOWS_SQL_MIN_MEMORY_GB', minMem: 4, minCpuVar: 'VM_WINDOWS_SQL_MIN_VCPUS', minCpu: 2 }
};
// Cheapest first. ZRS and Premium SSD v2 / Ultra are not offered automatically (not valid for every OS disk).
const DISK_ORDER = ['Standard_LRS', 'StandardSSD_LRS', 'Premium_LRS'];
const PG_TIER_RANK = { Burstable: 0, GeneralPurpose: 1, MemoryOptimized: 2 };

const isAuto = (v) => v === undefined || v === null || ['', 'auto'].includes(String(v).trim().toLowerCase());
const num = (v, d) => { const n = Number(String(v ?? '').trim()); return String(v ?? '').trim() !== '' && Number.isFinite(n) ? n : d; };
const money = (h) => `$${(h * 730).toFixed(2)}/month`;

module.exports = async function selectSkus({ core, exec, plan, vars, location }) {
  const loc = String(location || '').toLowerCase();
  const summary = [];

  async function azJson(args) {
    const r = await exec.getExecOutput('az', [...args, '-o', 'json'], { ignoreReturnCode: true, silent: true });
    if (r.exitCode !== 0) {
      const msg = String(r.stderr || r.stdout || '').trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ');
      throw new Error(`az ${args.slice(0, 3).join(' ')} failed: ${msg}`);
    }
    return JSON.parse(r.stdout || 'null');
  }

  // ---------------------------------------------------------------- cached lookups
  const cache = {};
  const once = (k, fn) => (cache[k] ??= fn());

  const vmSkus = () => once('vmSkus', async () => {
    const list = await azJson(['vm', 'list-skus', '--location', loc, '--resource-type', 'virtualMachines', '--all']);
    const out = {};
    for (const s of list || []) {
      if (s.resourceType !== 'virtualMachines') continue;
      const cap = Object.fromEntries((s.capabilities || []).map(c => [c.name, c.value]));
      const restr = s.restrictions || [];
      const locR = restr.find(r => r.type === 'Location');
      const zoneBlocked = new Set(restr.filter(r => r.type === 'Zone').flatMap(r => r.restrictionInfo?.zones || []));
      const li = (s.locationInfo || []).find(l => String(l.location).toLowerCase() === loc);
      out[s.name.toLowerCase()] = {
        name: s.name, family: String(s.family || '').toLowerCase(),
        vcpus: num(cap.vCPUs, 0), memoryGb: num(cap.MemoryGB, 0),
        gens: String(cap.HyperVGenerations || 'V1').split(',').map(x => x.trim().toUpperCase()),
        arch: String(cap.CpuArchitectureType || 'x64').toLowerCase(),
        premiumIO: String(cap.PremiumIO || '').toLowerCase() === 'true',
        available: !locR, reason: locR ? (locR.reasonCode || 'Restricted') : '',
        zones: (li?.zones || []).filter(z => !zoneBlocked.has(z)).sort()
      };
    }
    return out;
  });

  const diskSkus = () => once('diskSkus', async () => {
    const list = await azJson(['vm', 'list-skus', '--location', loc, '--resource-type', 'disks', '--all']);
    const ok = new Set();
    for (const s of list || []) if (!(s.restrictions || []).some(r => r.type === 'Location')) ok.add(String(s.name).toLowerCase());
    return ok;
  });

  const quota = () => once('quota', async () => {
    const list = await azJson(['vm', 'list-usage', '--location', loc]);
    const q = {};
    for (const u of list || []) q[String(u.name?.value || '').toLowerCase()] = num(u.limit, 0) - num(u.currentValue, 0);
    return q;
  });

  const images = {};
  const image = async (urn) => (images[urn] ??= azJson(['vm', 'image', 'show', '--location', loc, '--urn', urn]).then(i => ({
    gen: String(i?.hyperVGeneration || 'V1').toUpperCase(),
    arch: String(i?.architecture || 'x64').toLowerCase()
  })));

  const vmPrices = () => once('vmPrices', async () => {
    const filter = `serviceName eq 'Virtual Machines' and armRegionName eq '${loc}' and priceType eq 'Consumption'`;
    let url = `${PRICE_API}?$filter=${encodeURIComponent(filter)}`;
    const prices = { linux: {}, windows: {} };
    for (let page = 0; url && page < 400; page++) {
      let res;
      for (let attempt = 1; attempt <= 3; attempt++) {
        res = await fetch(url, { headers: { 'User-Agent': 'pike-eaas-sku-selection' } }).catch(e => ({ ok: false, status: e.message }));
        if (res.ok) break;
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
      if (!res.ok) throw new Error(`Azure Retail Prices API is not reachable from the runner (${res.status}).`);
      const data = await res.json();
      for (const i of data.Items || []) {
        const p = String(i.productName || ''), s = String(i.skuName || '');
        if (!(i.unitPrice > 0) || i.unitOfMeasure !== '1 Hour' || !i.armSkuName) continue;
        if (/Spot|Low Priority/i.test(s) || !p.startsWith('Virtual Machines') || /Dedicated|Cloud ?Services/i.test(p)) continue;
        let os;
        if (/Windows$/.test(p)) os = 'windows';
        else if (/RHEL|Red Hat|SUSE|SLES|Ubuntu Pro|Windows/i.test(p)) continue;
        else os = 'linux';
        const k = i.armSkuName.toLowerCase();
        if (!(k in prices[os]) || i.unitPrice < prices[os][k]) prices[os][k] = i.unitPrice;
      }
      url = data.NextPageLink;
    }
    return prices;
  });

  const pgCaps = () => once('pgCaps', async () => {
    const raw = await azJson(['postgres', 'flexible-server', 'list-skus', '--location', loc]);
    const list = Array.isArray(raw) ? raw : [raw];
    const skus = {}, versions = new Set(), storageMb = new Set();
    let restricted = '';
    const add = (s) => { if (s.name && !/disabled|restricted|unavailable/i.test(String(s.status || ''))) skus[s.name.toLowerCase()] ??= s; };
    for (const c of list) {
      if (!c) continue;
      if (String(c.restricted || '').toLowerCase() === 'enabled') restricted = c.reason || 'PostgreSQL Flexible Server is restricted for this subscription in this region.';
      for (const v of c.supportedServerVersions || []) versions.add(String(v.name));
      for (const e of c.supportedServerEditions || c.supportedFlexibleServerEditions || []) {
        for (const st of e.supportedStorageEditions || []) for (const m of st.supportedStorageMb || st.supportedStorageMB || []) storageMb.add(num(m.storageSizeMb ?? m.storageSizeMB, 0));
        for (const s of e.supportedServerSkus || []) add({ name: s.name, tier: e.name, vcores: num(s.vCores, 0), mem: num(s.supportedMemoryPerVcoreMb, 0), ha: s.supportedHaMode || s.supportedHAMode || [], zones: s.supportedZones || [], status: s.status });
        for (const v of e.supportedServerVersions || []) {
          versions.add(String(v.name));
          for (const vc of v.supportedVcores || []) add({ name: vc.name, tier: e.name, vcores: num(vc.vCores, 0), mem: num(vc.supportedMemoryPerVcoreMB ?? vc.supportedMemoryPerVcoreMb, 0), ha: [], zones: [], status: vc.status });
        }
      }
    }
    return { skus, versions, storageMb, restricted };
  });

  // ---------------------------------------------------------------- VM entries
  const used = {}; // vCPUs consumed by earlier entries in this run, per quota name
  async function resolveVm(entry, def) {
    const v = entry.variables || {};
    const sizeVar = v.vmSize, imageVar = v.imageReference, diskVar = v.osDiskStorageAccountType, osSizeVar = v.osDiskSizeGB;
    const urn = String(vars[imageVar] ?? '').trim();
    if (!urn) throw new Error(`GitHub Environment variable '${imageVar}' (VM image) is not set. Set it to publisher:offer:sku:version.`);
    const img = await image(urn).catch(e => { throw new Error(`Image '${urn}' is not available in ${loc}: ${e.message}`); });

    // OS disk size: auto -> 0 (image default, the smallest billing tier the image allows).
    if (osSizeVar && isAuto(vars[osSizeVar])) { entry.values = { ...entry.values, osDiskSizeGB: '0' }; delete v.osDiskSizeGB; }

    // Disk type: auto -> cheapest disk type offered in the region.
    let disk = vars[diskVar];
    if (isAuto(disk)) {
      const ok = await diskSkus();
      disk = DISK_ORDER.find(d => ok.has(d.toLowerCase()));
      if (!disk) throw new Error(`No managed disk type is available to this subscription in ${loc}.`);
      entry.values = { ...entry.values, osDiskStorageAccountType: disk }; delete v.osDiskStorageAccountType;
    }
    const needPremium = /^premium/i.test(String(disk));

    const skus = await vmSkus();
    const q = await quota();
    const left = (name) => (q[name] ?? Infinity) - (used[name] || 0);
    const fits = (s) => left(s.family) >= s.vcpus && left('cores') >= s.vcpus;
    const compatible = (s) => s.gens.includes(img.gen) && s.arch === img.arch && (!needPremium || s.premiumIO);
    const minMem = num(vars[def.minMemVar], def.minMem), minCpu = num(vars[def.minCpuVar], def.minCpu);

    const ranked = async () => {
      const prices = (await vmPrices())[def.os];
      return Object.values(skus)
        .filter(s => s.available && compatible(s) && s.memoryGb >= minMem && s.vcpus >= minCpu && fits(s) && prices[s.name.toLowerCase()] > 0)
        .map(s => ({ ...s, price: prices[s.name.toLowerCase()] }))
        .sort((a, b) => a.price - b.price || b.memoryGb - a.memoryGb || a.name.localeCompare(b.name));
    };
    const alternatives = async () => {
      try { return (await ranked()).slice(0, 3).map(s => `${s.name} (${s.vcpus} vCPU, ${s.memoryGb} GiB, ${money(s.price)})`).join(', ') || 'none found'; }
      catch (e) { return `could not be listed: ${e.message}`; }
    };

    let chosen, how;
    if (isAuto(vars[sizeVar])) {
      const list = await ranked();
      if (!list.length) throw new Error(`No VM size in ${loc} meets the requirements (${minCpu}+ vCPU, ${minMem}+ GiB, ${img.gen}, ${img.arch}${needPremium ? ', Premium storage' : ''}) and is available to this subscription with enough vCPU quota.`);
      chosen = list[0]; how = `auto: lowest cost available (${money(chosen.price)})`;
      entry.values = { ...entry.values, vmSize: chosen.name }; delete v.vmSize;
    } else {
      const want = String(vars[sizeVar]).trim();
      const s = skus[want.toLowerCase()];
      const problems = [];
      if (!s) problems.push(`'${want}' is not a VM size offered in ${loc}`);
      else {
        if (!s.available) problems.push(`'${want}' is restricted for this subscription in ${loc} (${s.reason})`);
        if (!compatible(s)) problems.push(`'${want}' does not support the image (${img.gen}, ${img.arch}${needPremium ? ', Premium storage' : ''})`);
        if (!fits(s)) problems.push(`not enough vCPU quota left for family ${s.family} in ${loc}`);
      }
      if (problems.length) throw new Error(`${sizeVar}: ${problems.join('; ')}. Cheapest available alternatives: ${await alternatives()}. Set ${sizeVar} to one of them, or to "auto".`);
      chosen = s; how = 'explicit: available';
    }
    used[chosen.family] = (used[chosen.family] || 0) + chosen.vcpus;
    used.cores = (used.cores || 0) + chosen.vcpus;
    summary.push([entry.label, chosen.name, `${chosen.vcpus} vCPU · ${chosen.memoryGb} GiB · disk ${entry.values?.osDiskStorageAccountType || vars[diskVar]}`, chosen.zones.join(', ') || 'regional (no zones)', how]);
  }

  // ---------------------------------------------------------------- PostgreSQL entry
  async function resolvePg(entry) {
    const v = entry.variables || {};
    const skuVar = v.skuName, tierVar = v.skuTier;
    const caps = await pgCaps();
    if (caps.restricted) throw new Error(`PostgreSQL Flexible Server in ${loc}: ${caps.restricted}`);
    const all = Object.values(caps.skus);
    if (!all.length) throw new Error(`No PostgreSQL Flexible Server SKU is available to this subscription in ${loc}.`);

    const version = String(vars[v.version] ?? '').trim();
    if (version && caps.versions.size && !caps.versions.has(version)) throw new Error(`PostgreSQL version ${version} is not offered in ${loc} (offered: ${[...caps.versions].join(', ')}).`);
    const storageGb = num(vars[v.storageSizeGB], 0);
    if (storageGb && caps.storageMb.size && !caps.storageMb.has(storageGb * 1024)) {
      throw new Error(`POSTGRESQL_STORAGE_SIZE_GB ${storageGb} is not offered in ${loc} (offered GB: ${[...caps.storageMb].map(m => m / 1024).sort((a, b) => a - b).join(', ')}).`);
    }

    const ha = String(vars[v.highAvailabilityMode] ?? 'Disabled').trim();
    const usable = (s) => (s.tier in PG_TIER_RANK) && (ha === 'Disabled' || (s.tier !== 'Burstable' && (!s.ha.length || s.ha.includes(ha))));
    const ranked = all.filter(usable).sort((a, b) =>
      PG_TIER_RANK[a.tier] - PG_TIER_RANK[b.tier] || a.vcores - b.vcores || a.mem - b.mem || a.name.localeCompare(b.name));
    const alts = ranked.slice(0, 3).map(s => `${s.name} (${s.tier}, ${s.vcores} vCore)`).join(', ') || 'none found';

    let chosen, how;
    if (isAuto(vars[skuVar])) {
      if (!ranked.length) throw new Error(`No PostgreSQL SKU in ${loc} supports high availability mode '${ha}' for this subscription.`);
      chosen = ranked[0]; how = 'auto: lowest tier and size available';
      entry.values = { ...entry.values, skuName: chosen.name, skuTier: chosen.tier }; delete v.skuName; delete v.skuTier;
    } else {
      const want = String(vars[skuVar]).trim();
      const s = caps.skus[want.toLowerCase()];
      if (!s) throw new Error(`POSTGRESQL_SKU '${want}' is not available to this subscription in ${loc}. Cheapest available alternatives: ${alts}. Set POSTGRESQL_SKU to one of them, or to "auto".`);
      if (!usable(s)) throw new Error(`POSTGRESQL_SKU '${want}' (${s.tier}) does not support high availability mode '${ha}'. Alternatives: ${alts}.`);
      const tier = vars[tierVar];
      if (!isAuto(tier) && String(tier).trim() !== s.tier) throw new Error(`POSTGRESQL_TIER '${tier}' does not match POSTGRESQL_SKU '${want}', which is ${s.tier}. Set POSTGRESQL_TIER to ${s.tier} or "auto".`);
      if (isAuto(tier)) { entry.values = { ...entry.values, skuTier: s.tier }; delete v.skuTier; }
      chosen = s; how = 'explicit: available';
    }
    summary.push([entry.label, chosen.name, `${chosen.tier} · ${chosen.vcores} vCore · ${storageGb || '?'} GB`, chosen.zones.join(', ') || 'regional', how]);
  }

  // ---------------------------------------------------------------- walk the plan
  for (const entry of plan) {
    entry.variables = { ...(entry.variables || {}) };
    entry.values = { ...(entry.values || {}) };
    try {
      if (VM_DEFAULTS[entry.key]) await resolveVm(entry, VM_DEFAULTS[entry.key]);
      else if (entry.key === 'postgresql') await resolvePg(entry);
    } catch (err) {
      entry.preflightError = `SKU check: ${err.message}`;
      core.error(`${entry.label}: ${entry.preflightError}`);
      summary.push([entry.label, '—', '—', '—', `failed: ${err.message.replace(/\|/g, '/')}`]);
    }
  }

  if (summary.length) {
    const rows = summary.map(r => `| ${r.join(' | ')} |`).join('\n');
    await core.summary.addRaw(`## SKU selection (${loc})\n\n| Resource | SKU | Details | Zones | Decision |\n|---|---|---|---|---|\n${rows}\n`).write();
  }
  return plan;
};
