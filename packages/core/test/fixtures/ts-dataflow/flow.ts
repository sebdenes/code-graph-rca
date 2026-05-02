// Fixture for pathBetween: userId flows from parseRequest through
// handleRequest to save.

export function parseRequest(req: { headers: { userId: string } }): string {
  const userId = req.headers.userId;
  return handleRequest(userId);
}

export function handleRequest(userId: string): string {
  return save(userId);
}

export function save(userId: string): string {
  return `saved:${userId}`;
}
