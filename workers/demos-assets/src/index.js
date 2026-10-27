// /demos/<path> is read from the R2 bucket at key <path>.
export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }
    const key = decodeURIComponent(new URL(request.url).pathname.replace(/^\/demos\//, ""));
    const object = request.method === "HEAD" ? await env.DEMOS.head(key) : await env.DEMOS.get(key);
    if (!object) return new Response("Not found", { status: 404 });

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("cache-control", "public, max-age=86400");
    return new Response(request.method === "HEAD" ? null : object.body, { headers });
  },
};
