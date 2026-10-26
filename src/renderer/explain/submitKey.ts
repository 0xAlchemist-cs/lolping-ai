/** IME confirmation and held keys must never turn into paid duplicate requests. */
export function submitOnEnter(event: KeyboardEvent, submit: () => void): void {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (event.repeat || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
  submit();
}
