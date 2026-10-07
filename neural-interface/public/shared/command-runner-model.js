// Pure library selection; saved command text and user ordering stay untouched.
const normalize = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0);
const lastRun = command => Number(command.lastRunAt) || 0;

export function selectCommandGroups(data, { query = '', categoryId = '', sort = 'saved' } = {}) {
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  const groups = [...data.categories].sort(byOrder)
    .filter(category => !categoryId || category.id === categoryId)
    .map(category => {
      const commands = data.commands.filter(command => {
        if (command.categoryId !== category.id) return false;
        const text = normalize([command.name, command.command, command.cwd, category.name].join(' '));
        return terms.every(term => text.includes(term));
      }).sort(sort === 'recent' ? (a, b) => lastRun(b) - lastRun(a) || byOrder(a, b) : byOrder);
      return { category, commands };
    }).filter(group => !terms.length || group.commands.length);
  if (sort === 'recent') groups.sort((a, b) =>
    Math.max(0, ...b.commands.map(lastRun)) - Math.max(0, ...a.commands.map(lastRun)) || byOrder(a.category, b.category));
  return groups;
}

export function commandLaunchPayload(command) {
  return { command: command.command, cwd: command.cwd || null, label: command.name };
}

// Internet connectivity does not gate commands served by the local workspace.
export function isCommandLaunchAvailable(online, hostname) {
  return online !== false || ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
}
