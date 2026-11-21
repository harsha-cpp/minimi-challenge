targetScope = 'resourceGroup'
param operatorObjectId string
param alertEmail string
var suffix = uniqueString(resourceGroup().id)
var tags = { owner: 'harsha' }
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = { name: 'asof-${suffix}' }
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = { name: 'asof${suffix}' }
resource vm 'Microsoft.Compute/virtualMachines@2024-07-01' existing = { name: 'asof-vm' }
resource operatorSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, operatorObjectId, 'secrets-officer')
  scope: vault
  properties: {
    principalId: operatorObjectId
    principalType: 'User'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
    )
  }
}
resource operatorBackupReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, operatorObjectId, 'backup-reader')
  scope: storage
  properties: {
    principalId: operatorObjectId
    principalType: 'User'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'
    )
  }
}
resource retention 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'backups-30-days'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: { blobTypes: ['blockBlob'], prefixMatch: ['backups/'] }
            actions: { baseBlob: { delete: { daysAfterModificationGreaterThan: 30 } } }
          }
        }
      ]
    }
  }
}
resource alerts 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: 'asof-operator'
  location: 'global'
  tags: tags
  properties: {
    groupShortName: 'asof'
    enabled: true
    emailReceivers: [{ name: 'operator', emailAddress: alertEmail, useCommonAlertSchema: true }]
  }
}
resource health 'Microsoft.Insights/activityLogAlerts@2020-10-01' = {
  name: 'asof-resource-health'
  location: 'global'
  tags: tags
  properties: {
    enabled: true
    scopes: [vm.id]
    condition: { allOf: [{ field: 'category', equals: 'ResourceHealth' }] }
    actions: { actionGroups: [{ actionGroupId: alerts.id }] }
  }
}
resource cpu 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'asof-cpu-pressure'
  location: 'global'
  tags: tags
  properties: {
    enabled: true
    severity: 2
    description: 'Sustained CPU pressure on the burstable application VM.'
    scopes: [vm.id]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    autoMitigate: true
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'cpu'
          metricName: 'Percentage CPU'
          metricNamespace: 'Microsoft.Compute/virtualMachines'
          operator: 'GreaterThan'
          threshold: 80
          timeAggregation: 'Average'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [{ actionGroupId: alerts.id }]
  }
}
