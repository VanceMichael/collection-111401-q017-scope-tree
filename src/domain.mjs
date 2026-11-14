import {capture} from './client.mjs';
import {openBrowser} from './browser.mjs';
export async function receiveCurrent(base,directory){const metadata=await capture(base+'/tree',directory);const browser=await openBrowser();try{const page=await browser.newPage();await page.goto(base+'/portal');await page.locator('[data-branch]').first().waitFor();return {receipt:metadata.receipt.id,regions:await page.locator('[data-branch]').count(),caption:await page.locator('h1').textContent()};}finally{await browser.close();}}
