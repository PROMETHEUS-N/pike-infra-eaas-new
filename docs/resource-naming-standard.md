# Pike Resource Naming — How Names Are Built

Resource names are **defined inside each Bicep module**. A module receives naming tokens as parameters and builds the name itself, for example:

```bicep
var resourceGroupName = 'rg-${workload}-${environmentName}'
```

The workflows never write out a full name. They pass only the token values, which come from `input.json` → `target`:

| Token | `input.json` key | Current value |
|---|---|---|
| `<env>` | `environment` | `dev` |
| `<workload>` | `target.workload` | `platform-svc` |
| `<system>` | `target.system` | `sap` |
| `<purpose>` | `target.purpose` | `app` (one purpose for the whole deployment; 2-11 lowercase letters/digits) |

## 1. Rules (from the Pike naming sheet)

- **Pattern:** one pattern for every resource: lowercase, hyphenated, environment last. **Exception:** Key Vault, storage account and Azure OpenAI use **no hyphens** (see below).
- **Tokens:**
  - `<env>` = `dev` | `qa` | `uat` | `prod`
  - `<workload>` = `int-<system>-<entity>` | `app-<name>` | `platform-svc` | `shared-infra`
  - `<system>` = source/target system (`sap`, `okta`, `fleet` …)
  - `<domain>` = business area (`hr`, `finance`, `ops` …)
- **Region code:** goes before `<env>` only if the deployment is multi-region. This is *not used*, because the deployment is single-region.
- **Globally unique names** include `pike`. **Key Vault, storage account, Azure OpenAI, PostgreSQL and Azure SQL server** also get a **unique suffix**, so they can never collide with a name already used anywhere in Azure:
  - pattern `<prefix>pike<purpose><env><suffix>`: all **lowercase**, **no spaces**, **no hyphens** (PostgreSQL and SQL server keep the hyphenated pattern, which they allow: `psql-pike-<purpose>-<env>-<suffix>`, `sql-<workload>-<env>-<suffix>`);
  - `<suffix>` = the first characters of `uniqueString(<resource group ID>)` (6 characters, shortened only when needed to stay within 24, never fewer than 3);
  - the suffix is **deterministic**: re-running in the same resource group gives the same name, so the resource is updated, not duplicated. Another subscription or resource group gets a different name.
- **Length limits:** every name is checked against the Microsoft limit in [section 2](#2-names-built-by-the-existing-modules).
- **Required tags:** `env`, `workload`, `owner`, `cost-center`, `data-class`. Every module adds `env` and `workload`. The other three come from the `RESOURCE_TAGS` variable, and the run fails if any of them is missing.

### Validation before deployment

- **`input.json`:** the `plan` job checks that `environment` is one of the four values and that every target is `yes` or `no`.
- **Workload and tags:** the `plan` job checks `input.json` → `target` (workload format, system, location); the `context` job checks the required tags.
- **Resource names:** the `plan` job builds every name that will be deployed and checks it against the Microsoft length and character rules in section 2. A name that is too long or has invalid characters fails the run **before** anything is deployed, and the run summary shows a *Resource name check* table.
- **Naming tokens:** `.github/actions/deploy-bicep` checks every token for lowercase letters/digits with single hyphens. `target.purpose` must be 2-11 lowercase letters/digits (no spaces, no hyphens), because it is part of the Key Vault and storage account names.
- **Module rules:** the same action also checks each module's own allowed values and minimum/maximum lengths before calling Azure.

## 2. Names built by the existing modules

Microsoft limits are from [Naming rules and restrictions for Azure resources](https://learn.microsoft.com/azure/azure-resource-manager/management/resource-name-rules) (storage: [Storage account overview](https://learn.microsoft.com/azure/storage/common/storage-account-overview); OpenAI subdomain: [Custom subdomain names](https://learn.microsoft.com/azure/ai-services/cognitive-services-custom-subdomains)).

| Resource | Module (where the name is defined) | Pattern | `dev` example | Microsoft limit: scope · length · characters | Pike max length |
|---|---|---|---|---|---|
| Resource group | `modules/RG/resourcegroup.bicep` | `rg-<workload>-<env>` | `rg-platform-svc-dev` | Subscription · **1–90** · letters, digits, `_` `-` `.` `(` `)`; cannot end with `.` | checked |
| Virtual network | `modules/networking/vnet.bicep` | `vnet-pike-<env>` | `vnet-pike-dev` | Resource group · **2–64** · letters, digits, `_` `.` `-`; start with letter/digit, end with letter/digit/`_` | 14 |
| Subnet | `modules/networking/subnet.bicep` | `snet-<purpose>` | `snet-app` | Virtual network · **1–80** · as VNet | 16 |
| Application Gateway subnet | `modules/networking/applicationGatewaySubnet.bicep` | `snet-<purpose>-agw` | `snet-app-agw` | Virtual network · **1–80** · as VNet | 20 |
| Application Gateway | `modules/networking/applicationGateway.bicep` | `agw-pike-<env>` (public IP `pip-agw-pike-<env>`) | `agw-pike-dev` | Resource group · **1–80** · as VNet | 13 / 17 |
| Network security group | `modules/networking/nsg.bicep` | `nsg-pike-<purpose>-<env>` | `nsg-pike-app-dev` | Resource group · **1–80** · as VNet | 25 |
| Route table | `modules/networking/routetable.bicep` | `rt-pike-<purpose>-<env>` | `rt-pike-app-dev` | Resource group · **1–80** · as VNet | 24 |
| Load balancer | `modules/loadbalancer/lb.bicep` | `lb-pike-<purpose>-<env>` | `lb-pike-app-dev` | Resource group · **1–80** · as VNet | 24 |
| **Key Vault** | `modules/security/keyvault.bicep` | `kvpike<purpose><env><suffix>` | `kvpikeappdev` + 6 chars | **Global** · **3–24** · letters, digits, `-`; start with a letter, end with letter/digit. **Pike: lowercase, no hyphens** | **24** |
| **Storage account** | `modules/storage/storageAccount.bicep` | `stpike<purpose><env><suffix>` | `stpikeappdev` + 6 chars | **Global** · **3–24** · **lowercase letters and digits only** | **24** |
| **Azure OpenAI** (name + custom subdomain) | `modules/ai/openai.bicep` | `oaipike<purpose><env><suffix>` | `oaipikeappdev` + 6 chars | Account: resource group · **2–64** · letters, digits, `-`; start/end alphanumeric. Subdomain: **global** · **2–64** · cannot end with `-`; cannot be changed later. **Pike: lowercase, no hyphens** | 28 |
| **Azure SQL server (apps)** | `modules/database/sql.bicep` | `sql-<workload>-<env>-<suffix>` | `sql-platform-svc-dev-` + 6 chars | **Global** · **1–63** · lowercase letters, digits, `-`; cannot start/end with `-` | checked (`workload` ≤ 47) |
| Azure SQL database | `modules/database/sql.bicep` | `<purpose>` | `app` | Server · **1–128** · no `<>*%&:\/?`; cannot end with `.` or space | 11 |
| **PostgreSQL flexible server** | `modules/database/postgresql.bicep` | `psql-pike-<purpose>-<env>-<suffix>` (delegated subnet `snet-<purpose>-psql`) | `psql-pike-app-dev-` + 6 chars | **Global** · **3–63** · lowercase letters, digits, `-`; cannot start/end with `-` | 33 |
| VM — Windows | `modules/compute/vm.bicep` (`vmType=windows`) | `vm-pike-<system>-<purpose>-win-<env>` | `vm-pike-sap-app-win-dev` | Resource group · resource name **1–64**; Windows **computer name 1–15**, no periods, cannot end with `-` | checked (limits `system`); computer name cut to 15 |
| VM — Linux | `modules/compute/vm.bicep` (`vmType=linux`) | `vm-pike-<system>-<purpose>-lnx-<env>` | `vm-pike-sap-app-lnx-dev` | Resource group · **1–64** (also the Linux computer name); cannot end with `.` or `-` | checked (limits `system`) |
| VM — Windows + SQL image | `modules/compute/vm.bicep` (`vmType=windows-sql`) | `vm-pike-<system>-<purpose>-sql-<env>` | `vm-pike-sap-app-sql-dev` | As VM — Windows | checked |
| VM network interface | `modules/compute/vm.bicep` | `nic-<vm name>` | `nic-vm-pike-sap-app-win-dev` | Resource group · **1–80** · as VNet | checked |
| Private DNS zone (PostgreSQL) | `modules/database/postgresql.bicep` | `POSTGRESQL_PRIVATE_DNS_ZONE_NAME` | `privatelink.postgres.database.azure.com` | Resource group · **1–63** characters, 2–34 labels | fixed value |
| RBAC assignment | `modules/access/rbac/*.bicep` | GUID derived from scope + principal + role | — | GUID | — |
| PIM eligibility request | `modules/access/pim/pim.bicep` | GUID derived from principal + role + start time | — | GUID | — |

"Pike max length" is the longest name the pattern can produce with the token limits the `plan` job enforces (`purpose` ≤ 11, `env` ≤ 4). Where it says **checked**, the length depends on `workload` or `system`, which have no fixed limit, so the `plan` job checks the real name on every run.

> ⚠️ **Soft delete keeps names reserved.** A deleted Key Vault keeps its name until its soft-delete retention period ends (7–90 days, `KEY_VAULT_SOFT_DELETE_RETENTION_DAYS`). A deleted Azure OpenAI account keeps its name for 48 hours unless purged. Because the suffix is stable per resource group, re-creating either one in the same resource group needs the deleted one to be recovered or purged first.

Sub-resources follow their parent: a VM NIC is `nic-<vm name>`. The Windows computer name is the first 15 characters of `<system><purpose><os><env>`. The PostgreSQL private DNS link is `link-vnet-pike-<env>`. The `-agw` and `-psql` suffixes keep the role-specific subnets separate from the main `snet-<purpose>` subnet, because the whole deployment shares one purpose.

## 3. Resource types on the sheet or in CLAUDE.md with no module

No modules were created for these. They are **not currently implemented**.

| Resource | Pattern (Pike sheet / CLAUDE.md) |
|---|---|
| Subscription | `sub-pike-acs-<env>` |
| Container Apps environment / app / job | `cae-pike-<env>` / `ca-<workload>[-<role>]-<env>` / `caj-<workload>-<job>-<env>` |
| Container registry | `crpike<purpose>` |
| Managed identity | `id-<workload>-<env>` |
| Service Bus namespace / queue / topic / subscription | `sbns-pike-<env>` / `q-<system>-<entity>` / `sbt-<domain>-<event>` / `sbs-<target>` |
| Event Grid / Event Hubs | `egns-pike-<env>` / `evhns-pike-<env>` |
| API Management | `apim-pike-<env>` / `<domain>-api` |
| Front Door | `afd-pike-<env>` |
| Log Analytics / App Insights | `log-pike-<env>` / `appi-<workload>-<env>` |
| Bastion, DNS zone, Private Endpoint, Cosmos DB, AKS, App Service, Logic App, Function App, Redis, VPN Gateway, Data Lake Gen2, Power BI, Fabric, ACS | See CLAUDE.md section 3 |

