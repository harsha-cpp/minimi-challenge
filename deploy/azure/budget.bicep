targetScope = 'resourceGroup'
@description('Budget amount in the subscription billing currency, not implicitly USD.')
param amount int
param startDate string
param alertEmail string
resource budget 'Microsoft.Consumption/budgets@2024-08-01' = {
  name: 'asof-infrastructure-monthly'
  properties: {
    category: 'Cost'
    amount: amount
    timeGrain: 'Monthly'
    timePeriod: { startDate: startDate }
    notifications: {
      warning: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 80
        thresholdType: 'Actual'
        contactEmails: [alertEmail]
      }
      critical: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 90
        thresholdType: 'Actual'
        contactEmails: [alertEmail]
      }
      limit: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Actual'
        contactEmails: [alertEmail]
      }
    }
  }
}
