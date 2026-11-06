export async function honoFetch(path: string) {
  return Response.json(
    path === "ai-models" ? { defaultId: null, models: [] } : { projects: [], nextCursor: null },
  );
}
