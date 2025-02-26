export default async (request, context) => {
  try {
    const url = new URL(request.url);

    // Handle WebSocket requests (only WebSocket upgrade)
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader && upgradeHeader.toLowerCase() === "websocket") {
      const backendParam = url.searchParams.get("backend");
      if (!backendParam) {
        return new Response("Missing 'backend' query parameter.", { status: 400 });
      }

      // Redirect WebSocket requests directly to Fastly
      url.hostname = 'v2ray.dopekidanime.tech'; // server hostname
      url.protocol = 'http:'; // Ensure HTTP for server
      url.pathname = url.pathname; // Ensure backend path is forwarded to server

      const modifiedRequest = new Request(url, {
        method: request.method,
        headers: request.headers, // Preserve WebSocket headers
      });

      // Forward the WebSocket request to server
      return fetch(modifiedRequest);  // server handles WebSocket connection
    }

    // Reject non-WebSocket requests
    return new Response("Only WebSocket connections are supported.", { status: 400 });
  } catch (error) {
    console.error("Error during fetch:", error);
    return new Response("Internal server error.", { status: 500 });
  }
};