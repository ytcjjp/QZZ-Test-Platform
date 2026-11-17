const form = document.querySelector('#pair-form');
const error = document.querySelector('#error');
const controls = [...document.querySelectorAll('button')];
const render = (status) => {
  document.querySelector('#status').textContent = status.message;
  document.querySelector('#indicator').dataset.state = status.state;
  if (document.activeElement !== document.querySelector('#port')) document.querySelector('#port').value = status.port || 3210;
};
async function request(message) {
  error.hidden = true; controls.forEach((control) => { control.disabled = true; });
  try {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error?.message || '扩展连接暂不可用，请关闭弹窗后重试。');
    if (result.status) render(result.status);
    return result;
  } catch (failure) { error.textContent = failure.message; error.hidden = false; }
  finally { controls.forEach((control) => { control.disabled = false; }); }
}
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = document.querySelector('#code');
  const result = await request({ type: 'pair', port: document.querySelector('#port').value, code: code.value });
  if (result?.ok) code.value = '';
});
document.querySelector('#reconnect').addEventListener('click', () => request({ type: 'reconnect' }));
document.querySelector('#disconnect').addEventListener('click', () => request({ type: 'disconnect' }));
chrome.runtime.onMessage.addListener((message) => { if (message.type === 'bridgeStatus') render(message.status); });
void request({ type: 'getStatus' });
