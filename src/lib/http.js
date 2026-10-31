export const ok = (res, data = {}, meta, status = 200) => res.status(status).json({ ok: true, data, ...(meta ? { meta } : {}) });
export const page = (res, items, total, q) => ok(res, items, { page: q.page, pageSize: q.pageSize, total, totalPages: Math.max(1, Math.ceil(total / q.pageSize)) });
export const noStore = (res) => res.setHeader('Cache-Control', 'no-store');
