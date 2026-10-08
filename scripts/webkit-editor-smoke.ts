#!/usr/bin/env bun
/** Native WebKit pointer regression against synthetic desktop preview data.
 * Build: bun run --cwd apps/desktop preview:build
 * Optional tool: install Playwright + WebKit outside product dependencies; set
 * ONEWARDEN_PLAYWRIGHT to its absolute index.mjs path before running this script.
 * Example: ONEWARDEN_PLAYWRIGHT=/path/to/playwright/index.mjs bun scripts/webkit-editor-smoke.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
const { webkit } = await import(process.env.ONEWARDEN_PLAYWRIGHT
  ? pathToFileURL(resolve(process.env.ONEWARDEN_PLAYWRIGHT)).href : 'playwright');
import { join, resolve } from 'node:path';
const directory=resolve(import.meta.dir, '..', 'apps/desktop/dist-preview');
const output=resolve(process.env.ONEWARDEN_WEBKIT_OUTPUT ?? join(tmpdir(), `onewarden-webkit-${Date.now()}`));
mkdirSync(output, {recursive:true});
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){const path=new URL(request.url).pathname;const f=Bun.file(join(directory,path==='/'?'index.html':path));return await f.exists()?new Response(f):new Response('',{status:404});}});
const browser=await webkit.launch({headless:true});
const checks:string[]=[];
try {
 const context=await browser.newContext({viewport:{width:1080,height:720}});
 const page=await context.newPage(); const errors:string[]=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.port}/?screen=form`);
 await page.getByRole('button',{name:'信用卡',exact:true}).click();
 await page.locator('[data-editor-add-more]').click();
 await page.locator('[data-add-field="card.brand"]').click();
 await page.locator('[data-editor-field="card.brand"]').waitFor({state:'visible',timeout:3000});
 await page.locator('[data-editor-field="card.brand"] select').waitFor({state:'visible',timeout:3000});
 checks.push('WebKit native pointer adds the second menu choice and focuses card-brand select');
 if(!await page.locator('[aria-label="卡片品牌"]').evaluate((e:Element)=>document.activeElement===e))throw Error('brand select missing focus');
 await page.getByLabel('卡片品牌',{exact:true}).selectOption('Mastercard');
 if(await page.getByLabel('卡片品牌',{exact:true}).inputValue()!=='Mastercard')throw Error('select failed');
 checks.push('card brand is selectable');
 await page.locator('[data-editor-add-more]').click();
 await page.getByRole('menuitem',{name:'自定义 · 隐藏',exact:true}).click();
 if(await page.getByLabel('字段 1 类型',{exact:true}).inputValue()!=='1')throw Error('wrong custom type');
 checks.push('WebKit native pointer adds a custom hidden field');
 await page.locator('[data-editor-add-more]').click();
 await page.keyboard.press('Escape');
 if(await page.getByRole('menu',{name:'添加更多'}).count())throw Error('Escape did not close picker');
 if(!await page.locator('[data-editor-add-more]').evaluate((e:Element)=>document.activeElement===e))throw Error('Escape missing return focus');
 checks.push('Escape closes only picker and restores focus');
 await page.locator('[data-editor-add-more]').click();
 await page.locator('#editor-title').click();
 if(await page.getByRole('menu',{name:'添加更多'}).count())throw Error('outside did not close picker');
 checks.push('outside pointer closes picker');
 await page.locator('[data-editor-add-more]').click();
 const choice=page.getByRole('menuitem').nth(1);
 await choice.scrollIntoViewIfNeeded();
 const choiceBox=await choice.boundingBox();
 const headingBox=await page.locator('#editor-title').boundingBox();
 await page.mouse.move(choiceBox!.x+choiceBox!.width/2,choiceBox!.y+choiceBox!.height/2);
 await page.mouse.down();
 await page.mouse.move(headingBox!.x+headingBox!.width/2,headingBox!.y+headingBox!.height/2);
 await page.mouse.up();
 await page.keyboard.press('Escape');
 if(await page.getByRole('menu',{name:'添加更多'}).count())throw Error('cancelled pointer left picker open after Escape');
 if(await page.getByRole('button',{name:'放弃改动',exact:true}).count())throw Error('cancelled pointer Escape reached editor');
 checks.push('dragging a menu press away does not choose and Escape stays in picker');
 await page.locator('[data-editor-add-more]').click();
 await page.keyboard.press('End');
 await page.keyboard.press('Tab');
 if(await page.getByRole('menu',{name:'添加更多'}).count())throw Error('Tab did not dismiss picker after leaving last option');
 checks.push('real Tab traversal dismisses picker');
 await page.screenshot({path:join(output, 'editor.png')});
 await page.goto(`http://127.0.0.1:${server.port}/?screen=vault`);
 await page.locator('.vault-list li > button').first().click();
 const folder=page.locator('[data-folder-organization]');
 if(await folder.locator('option').filter({hasText:'新建文件夹'}).count())throw Error('duplicate new-folder entry');
 if(await folder.getByRole('button',{name:'新建文件夹',exact:true}).count()!==1)throw Error('missing unique new-folder action');
 await folder.getByRole('button',{name:'新建文件夹',exact:true}).click();
 await folder.locator('[data-item-folder-name]').waitFor({state:'visible'});
 await page.keyboard.press('Escape');
 if(await folder.locator('[data-item-folder-name]').count())throw Error('Escape did not close creation');
 if(!await page.locator('.vault-detail article').count())throw Error('Escape closed detail');
 checks.push('single folder-create action; Escape keeps selected detail');
 if(errors.length)throw Error(errors.join('\n'));
 const report={browser:await browser.version(),checks,errors};
 writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));
 console.log(`PASS WebKit ${report.browser}: ${checks.length} checks; artifacts: ${output}`);
} finally {await browser.close();server.stop(true);}
