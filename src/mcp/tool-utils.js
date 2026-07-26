function ok(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

function safeTool(handler) {
  return async (args) => {
    try {
      return await handler(args);
    } catch (error) {
      return { content: [{ type: "text", text: error?.message ?? String(error) }], isError: true };
    }
  };
}

export { ok, safeTool };
