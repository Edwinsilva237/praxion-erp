import api from './axios'

export const exchangeRatesApi = {
  getLatest: () => api.get('/exchange-rates/latest').then(r => r.data),
  getRate: (currency = 'USD') => api.get('/exchange-rates/latest').then(r => {
    const rates = r.data
    if (Array.isArray(rates)) {
      const found = rates.find(x => x.currency === currency || x.from_currency === currency)
      return found?.rate || found?.exchange_rate || null
    }
    return rates?.rate || rates?.exchange_rate || null
  }),
}
