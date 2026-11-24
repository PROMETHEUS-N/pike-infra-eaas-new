// Pike naming: oaipike<purpose><env><suffix>      e.g. oaipikeappdev + 6-char suffix
//
// Microsoft rules:
//   - Account name (Microsoft.CognitiveServices/accounts): unique in the resource group, 2-64 characters,
//     alphanumerics and hyphens, must start and end with an alphanumeric.
//   - Custom subdomain (customSubDomainName -> https://<name>.openai.azure.com): unique across Azure,
//     2-64 characters, alphanumerics and hyphens, cannot end with a hyphen. It cannot be changed later.
// Pike rule on top: all lowercase, no spaces, no hyphens. The same value is used for both.
//
// Uniqueness: <suffix> = uniqueString(resource group ID), 6 characters. It is deterministic, so a re-run
// in the same resource group gets the same name (idempotent). Note: a deleted account keeps its name for
// 48 hours (soft delete) unless it is purged.
//
// Length: oaipike(7) + purpose(2-11) + env(2-4) + suffix(6) = 17-28 characters (limit 64).

@description('Environment token.')
@allowed(['dev', 'qa', 'uat', 'prod'])
param environmentName string

@description('Workload token (used for the workload tag).')
@minLength(3)
@maxLength(60)
param workload string

@description('Deployment purpose token (input.json target.purpose).')
@minLength(2)
@maxLength(11)
param purpose string

@description('Azure region.')
param location string

@description('Azure OpenAI SKU name.')
param skuName string

@description('Public network access setting.')
@allowed([
  'Enabled'
  'Disabled'
])
param publicNetworkAccess string

@description('Tags. Must contain owner, cost-center and data-class; env and workload are added here.')
param tags object

// Lowercase only, with no spaces, hyphens, underscores or periods, even if a caller passes such a token.
var accountNameBase = toLower(replace(replace(replace(replace('oaipike${purpose}${environmentName}', ' ', ''), '-', ''), '_', ''), '.', ''))
var accountName = '${accountNameBase}${take(uniqueString(resourceGroup().id, 'Microsoft.CognitiveServices/accounts'), 6)}'

resource openAiService 'Microsoft.CognitiveServices/accounts@2023-05-01' = {
  name: accountName
  location: location
  kind: 'OpenAI'
  sku: {
    name: skuName
  }
  properties: {
    customSubDomainName: accountName
    publicNetworkAccess: publicNetworkAccess
  }
  tags: union(tags, { env: environmentName, workload: workload })
}

output deployedResourceId string = openAiService.id
output deployedResourceName string = openAiService.name
output endpoint string = openAiService.properties.endpoint
