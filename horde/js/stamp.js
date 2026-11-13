// Marks who caused each new log entry. Shared by the browser and the room server
// so both copies of the game state stay identical (see server/PROTOCOL.md).
export function stampLog(state, name) {
  const log = state.log || [];
  for (let i = log.length - 1; i >= 0 && log[i].by === undefined; i--) log[i].by = name;
  return state;
}
