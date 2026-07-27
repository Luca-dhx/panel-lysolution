// Enveloppes de succès communes aux deux surfaces.
export function ok(res, data) {
  return res.status(200).json({ success: true, data });
}

export function created(res, data) {
  return res.status(201).json({ success: true, data });
}
