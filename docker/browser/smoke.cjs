const assert = require('node:assert/strict');
const http = require('node:http');
const { chromium } = require('./node_modules/playwright');

async function main() {
  assert.notEqual(process.getuid(), 0, 'Browser smoke must run as the agent user');
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>Paperclip browser smoke</title><h1 id="result">loading</h1><script>document.querySelector("#result").textContent = "ready"</script>');
  });
  let browser;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    browser = await chromium.launch({ headless: true, timeout: 30000 });
    const page = await browser.newPage();
    const response = await page.goto(`http://127.0.0.1:${server.address().port}`, { timeout: 15000 });
    assert.equal(response.status(), 200);
    assert.equal(await page.title(), 'Paperclip browser smoke');
    assert.equal(await page.locator('#result').textContent(), 'ready');
    console.log(`Chromium ${browser.version()} smoke passed as uid ${process.getuid()}`);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
