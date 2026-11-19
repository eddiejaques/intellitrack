export const app = document.querySelector('#app');
export const status = text => { document.querySelector('#status').textContent = text; };
export function element(tag,text) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  return node;
}
export function button(label,action) {
  const node = element('button',label);
  node.type = 'button';
  node.onclick = async () => {
    node.disabled = true;
    status('');
    try { await action(); } catch (error) { status(error.message); }
    finally { node.disabled = false; }
  };
  return node;
}
export async function send(type,fields = {}) {
  const response = await chrome.runtime.sendMessage({type,...fields});
  if (!response) throw new Error('The extension did not respond. Retry the action.');
  if (response.error) throw new Error(response.error);
  return response.value;
}
export function download(name,data,mime) {
  const url = URL.createObjectURL(new Blob([data],{type:mime}));
  const link = element('a');
  link.download = name;
  link.href = url;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url),1000);
}
