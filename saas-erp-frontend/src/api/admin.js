import api from './axios'

const B = '/admin'

export const adminApi = {
  // Lista jobs de una cola. queue: 'emails'|'invoicing'. status: 'failed'|'completed'|...
  listJobs: (queue = 'emails', status = 'failed', limit = 50) =>
    api.get(`${B}/jobs`, { params: { queue, status, limit } }).then(r => r.data),

  retryJob: (queue, jobId) =>
    api.post(`${B}/jobs/${queue}/${jobId}/retry`).then(r => r.data),

  removeJob: (queue, jobId) =>
    api.delete(`${B}/jobs/${queue}/${jobId}`).then(r => r.data),
}
