// Pike naming: kvpike<purpose><env><suffix>      e.g. kvpikeappdev + 6-char suffix
//
// Microsoft rule (Microsoft.KeyVault/vaults): globally unique, 3-24 characters, alphanumerics and
// hyphens, must start with a letter, end with a letter or digit, no consecutive hyphens.
// Pike rule on top: all lowercase, no spaces, no hyphens.
//
// Globally defined GUID: resourceGuid = guid(resource group ID, resource type), declared here in the
// module (not in the workflow). The resource group ID already contains the subscription ID, so the GUID
// is unique across Azure. <suffix> = uniqueString(resourceGuid), so the name is derived from that GUID.
// It is deterministic, so a re-run in the same resource group gets the same name (idempotent), while another subscription / resource group gets a
// different one. Note: a soft-deleted vault keeps its name until the retention period ends or it is purged.
//
// Length budget (max 24): kvpike(6) + purpose(2-11) + env(2-4) = 10-21, suffix fills the rest up to 6.
// The suffix is never shorter than 3 characters, so the name is always 13-24 characters.

@description('Environment token.')
@allowed(['dev', 'qa', 'uat', 'prod'])
param environmentName string

@description('Workload token (used for the workload tag).')
@minLength(3)
@maxLength(60)
param workload string

@description('Deployment purpose token (input.json target.purpose), lowercase letters/digits.')
@minLength(2)
@maxLength(11)
param purpose string

@description('Azure region.')
param location string

@description('Microsoft Entra tenant ID. Defaults to the tenant of the deployment.')
param tenantId string = tenant().tenantId

@description('Key Vault SKU name.')
@allowed([
  'standard'
  'premium'
])
param skuName string

@description('Key Vault SKU family.')
@allowed([
  'A'
])
param skuFamily string

@description('Use Azure RBAC for data-plane authorization.')
param enableRbacAuthorization bool

@description('Enable purge protection.')
param enablePurgeProtection bool

@description('Soft-delete retention in days.')
@minValue(7)
@maxValue(90)
param softDeleteRetentionInDays int

@description('Public network access setting.')
@allowed([
  'Enabled'
  'Disabled'
])
param publicNetworkAccess string

@description('Tags. Must contain owner, cost-center and data-class; env and workload are added here.')
param tags object

// Lowercase only, with no spaces, hyphens, underscores or periods, even if a caller passes such a token.
var keyVaultNameBase = toLower(replace(replace(replace(replace('kvpike${purpose}${environmentName}', ' ', ''), '-', ''), '_', ''), '.', ''))
var resourceGuid = guid(resourceGroup().id, 'Microsoft.KeyVault/vaults')
var keyVaultNameSuffix = take(uniqueString(resourceGuid), min(6, 24 - length(keyVaultNameBase)))
var keyVaultName = '${keyVaultNameBase}${keyVaultNameSuffix}'

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  tags: union(tags, { env: environmentName, workload: workload })
  properties: {
    tenantId: tenantId
    enableRbacAuthorization: enableRbacAuthorization
    enablePurgeProtection: enablePurgeProtection
    softDeleteRetentionInDays: softDeleteRetentionInDays
    publicNetworkAccess: publicNetworkAccess
    sku: {
      name: skuName
      family: skuFamily
    }
  }
}

output deployedResourceId string = keyVault.id
output deployedResourceName string = keyVault.name
output resourceGuid string = resourceGuid
