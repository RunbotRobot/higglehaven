// Which side of a direct-message thread a message is on. A message is mine when it was addressed to the person the
// thread is with; the earlier test compared the sender with the module's builderId, which Shop mode never sets,
// so in Shop every message looked like theirs (found looking at the Messages leaf for #3939).
export function isSentByMe(message, otherBuilderId) {
  return Boolean(otherBuilderId) && message?.recipientBuilderId === otherBuilderId;
}
