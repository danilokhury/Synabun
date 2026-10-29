// Running is a display hint: tool activity, replay and automation reattachment
// can all set it. Only a new prompt gives completion notifications a new owner.
export function createOutcomeNotifications() {
  const outcomes = new Map();
  return {
    take(state, type) {
      const prompt = [...(state.messageOrder || [])].reverse().find(id => state.messages?.get(id)?.role === 'user');
      const key = `${state.sessionId || ''}:${prompt || ''}`;
      const last = outcomes.get(key);
      if (last === type || (last === 'error' && type === 'done')) return false;
      outcomes.set(key, type);
      if (outcomes.size > 200) outcomes.delete(outcomes.keys().next().value);
      return true;
    },
  };
}
