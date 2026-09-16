// Keep native and extension tools; enable Pi's optional repository search tools.
export default function nativeTools(pi) {
  pi.on('session_start', async () => {
    const available = new Set(pi.getAllTools().map(tool => tool.name));
    const active = new Set(pi.getActiveTools());
    for (const name of ['grep', 'find', 'ls', 'powershell']) {
      if (available.has(name)) active.add(name);
    }
    pi.setActiveTools([...active]);
  });
}
