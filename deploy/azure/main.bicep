targetScope = 'resourceGroup'
param location string = 'centralindia'
param sshPublicKey string
param adminCidr string
param adminUsername string = 'asofadmin'
param vmSize string = 'Standard_B2als_v2'
@description('Resolve and record an exact Ubuntu image version before deployment.')
param imageVersion string
var tags = { owner: 'harsha' }
var suffix = uniqueString(resourceGroup().id)
resource nsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: 'asof-nsg'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'ssh-admin'
        properties: {
          priority: 100
          protocol: 'Tcp'
          access: 'Allow'
          direction: 'Inbound'
          sourceAddressPrefix: adminCidr
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '22'
        }
      }
      {
        name: 'web'
        properties: {
          priority: 110
          protocol: 'Tcp'
          access: 'Allow'
          direction: 'Inbound'
          sourceAddressPrefix: 'Internet'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRanges: ['80', '443']
        }
      }
    ]
  }
}
resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: 'asof-vnet'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: ['10.42.0.0/16'] }
    subnets: [{ name: 'app', properties: { addressPrefix: '10.42.0.0/24', networkSecurityGroup: { id: nsg.id } } }]
  }
}
resource ip 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: 'asof-ip'
  location: location
  tags: tags
  sku: { name: 'Standard' }
  properties: { publicIPAllocationMethod: 'Static', dnsSettings: { domainNameLabel: 'asof-${suffix}' } }
}
resource nic 'Microsoft.Network/networkInterfaces@2024-05-01' = {
  name: 'asof-nic'
  location: location
  tags: tags
  properties: {
    ipConfigurations: [
      {
        name: 'primary'
        properties: {
          privateIPAllocationMethod: 'Dynamic'
          subnet: { id: '${vnet.id}/subnets/app' }
          publicIPAddress: { id: ip.id }
        }
      }
    ]
  }
}
resource vm 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: 'asof-vm'
  location: location
  tags: tags
  identity: { type: 'SystemAssigned' }
  properties: {
    hardwareProfile: { vmSize: vmSize }
    osProfile: {
      computerName: 'asof'
      adminUsername: adminUsername
      linuxConfiguration: {
        disablePasswordAuthentication: true
        ssh: { publicKeys: [{ path: '/home/${adminUsername}/.ssh/authorized_keys', keyData: sshPublicKey }] }
      }
    }
    storageProfile: {
      imageReference: { publisher: 'Canonical', offer: 'ubuntu-24_04-lts', sku: 'server', version: imageVersion }
      osDisk: {
        createOption: 'FromImage'
        diskSizeGB: 64
        managedDisk: { storageAccountType: 'StandardSSD_LRS' }
        deleteOption: 'Detach'
      }
    }
    networkProfile: { networkInterfaces: [{ id: nic.id }] }
    diagnosticsProfile: { bootDiagnostics: { enabled: false } }
  }
}
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'asof-${suffix}'
  location: location
  tags: tags
  properties: {
    tenantId: tenant().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    enablePurgeProtection: true
    softDeleteRetentionInDays: 7
    accessPolicies: []
  }
}
resource vaultRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, vm.id, 'secrets-user')
  scope: vault
  properties: {
    principalId: vm.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '4633458b-17de-408a-b874-0445c86b69e6'
    )
  }
}
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'asof${suffix}'
  location: location
  tags: tags
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    accessTier: 'Hot'
  }
}
resource blob 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: { deleteRetentionPolicy: { enabled: true, days: 7 } }
}
resource backups 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blob
  name: 'backups'
  properties: { publicAccess: 'None' }
}
resource backupWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(backups.id, vm.id, 'blob-writer')
  scope: backups
  properties: {
    principalId: vm.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
    )
  }
}
output hostname string = ip.properties.dnsSettings.fqdn
output vaultName string = vault.name
output storageName string = storage.name
