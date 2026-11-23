# 🗄️ Storage Account module — `storageAccount.bicep`

Creates a **general-purpose Storage Account** with its blob service and a list of blob containers.

| | |
|---|---|
| **File** | [storageAccount.bicep](storageAccount.bicep) |
| **Azure resources** | `Microsoft.Storage/storageAccounts`, `…/blobServices`, `…/blobServices/containers` (`@2023-05-01`) |
| **Deployment scope** | Resource group |
| **`input.json` key** | `resourceTargets.storageAccount` |
| **Name** | `stpike<purpose><env>` → e.g. `stpikeappdev` |

---

## What is a Storage Account?

It is a container for Azure Storage data services: blobs, files, queues and tables. This module enables the **blob** service and creates the containers listed in `STORAGE_ACCOUNT_CONTAINER_NAMES`.

---

## Dependencies

```mermaid
flowchart LR
    RG["Resource group"] --> ST["stpike&lt;purpose&gt;&lt;env&gt;"]
    ST --> BS["blobServices/default"] --> C["containers<br/>(STORAGE_ACCOUNT_CONTAINER_NAMES)"]
    ST -. "RBAC_SCOPE = storageAccount" .-> RBAC["RBAC role assignment"]

    classDef st fill:#dbeafe,stroke:#2563eb,color:#172554
    class ST,BS,C st
```

| Direction | Resource | Notes |
|---|---|---|
| **Needs** | Resource group | No network dependency; public network access is controlled by a variable |
| **Needed by** | RBAC with `RBAC_SCOPE=storageAccount` | `RBAC_resource.bicep` looks the account up by `RBAC_STORAGE_ACCOUNT_NAME` |

---

## Naming rules

Storage account names must be **3–24 characters, lowercase letters and digits only, and globally unique**. The module therefore:

- builds `stpike` + `purpose` + `env` with no separators;
- removes spaces, `-`, `_` and `.` and lower-cases the result, so a non-compliant name can never be produced;
- relies on the `pike` prefix for global uniqueness. If the name is already taken in another subscription, the deployment fails with `StorageAccountAlreadyTaken`, and a different `purpose` is needed.

Length budget: `stpike` (6) + purpose (≤ 11) + env (≤ 4) = at most 21 characters.

---

## Parameters

| Parameter | Source | `dev` value | Description |
|---|---|---|---|
| `skuName` | `STORAGE_ACCOUNT_SKU` | `Standard_LRS` | Redundancy: `Standard_LRS`, `Standard_ZRS`, `Standard_GRS`, `Standard_RAGRS`, `Premium_LRS`, … |
| `kind` | `STORAGE_ACCOUNT_KIND` | `StorageV2` | |
| `accessTier` | `STORAGE_ACCOUNT_ACCESS_TIER` | `Hot` | `Hot` / `Cool` |
| `minimumTlsVersion` | `STORAGE_ACCOUNT_MIN_TLS_VERSION` | `TLS1_2` | |
| `supportsHttpsTrafficOnly` | `STORAGE_ACCOUNT_HTTPS_ONLY` | `true` | |
| `allowBlobPublicAccess` | `STORAGE_ACCOUNT_ALLOW_BLOB_PUBLIC_ACCESS` | `false` | |
| `allowSharedKeyAccess` | `STORAGE_ACCOUNT_ALLOW_SHARED_KEY_ACCESS` | `true` | |
| `publicNetworkAccess` | `STORAGE_ACCOUNT_PUBLIC_NETWORK_ACCESS` | `Enabled` | `Enabled` / `Disabled` |
| `containerNames` | `STORAGE_ACCOUNT_CONTAINER_NAMES` | `["appdata"]` | JSON array |
| `blobServiceName` | `STORAGE_ACCOUNT_BLOB_SERVICE_NAME` | `default` | Must be `default` |
| `containerPublicAccess` | `STORAGE_ACCOUNT_CONTAINER_PUBLIC_ACCESS` | `None` | `None` / `Blob` / `Container` |
| `environmentName`, `workload`, `purpose`, `location`, `tags` | `input.json` / `RESOURCE_TAGS` | | |

## Outputs

| Output | Description |
|---|---|
| `deployedResourceId` | Storage account resource ID |
| `deployedResourceName` | Final account name |
| `containerNamesOut` | The containers that were created |

---

## Notes

- Blob soft delete is **disabled** (`deleteRetentionPolicy.enabled: false`).
- A Data Lake Gen2 account (hierarchical namespace) is **not** supported by this module.
- Changing `skuName` between some redundancy types (for example to or from `Premium_LRS`) is not an in-place update in Azure.
