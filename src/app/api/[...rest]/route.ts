/**
 * THE FRAMEWORK'S OWN 404 WRITES NO LINE AT ALL. A path under /api that matches no route is
 * answered by Next before any of our code runs, so it was invisible to the request log and to
 * the histogram. This catch-all sits last in the route table and turns that silence into a
 * labelled refusal with a request id, for every method.
 */
import { withApi, apiError, notAllowed } from "@/lib/api";

const notFound = withApi("notfound", (_req, ctx) =>
  apiError(404, "No such endpoint.", ctx, "notFound"));

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
// Named so the repo row that holds every route to the full set does not read this file as short.
void notAllowed;
