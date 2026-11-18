/** Include the session checkout without registering it as a global project or changing Git. */
export function sessionProjectItems(projects, cwd = '') {
  const items = projects.map(p => {
    const path = typeof p === 'string' ? p : p.path;
    return { value: path, label: p.label || path.split(/[/\\]/).filter(Boolean).pop() || path };
  });
  if (cwd && !items.some(item => item.value === cwd)) {
    items.unshift({ value: cwd, label: cwd.split(/[/\\]/).filter(Boolean).pop() || cwd });
  }
  return items;
}
