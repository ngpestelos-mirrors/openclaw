from pathlib import Path
p=Path('scripts/bench-control-ui-cold-load.ts').read_text()
p=p.replace('const page = await context.newPage();', '''const page = await context.newPage();
  await page.addInitScript({path: ".local/l64/probe.js"});
  await page.addInitScript({path: ".local/l64/loaf.js"});
  await page.addInitScript({path: ".local/l64/ws.js"});''')
p=p.replace('const url = controlUiSessionUrl(server.baseUrl, fixture.selectedSessionKey, "dashboard");', '''const url = controlUiSessionUrl(server.baseUrl, fixture.selectedSessionKey, "dashboard") + (process.env.L64_STACKS ? "?l64stacks=1" : "");''')
p=p.replace('const metrics = await page.evaluate(() => Reflect.get(window, "__coldLoad").read());', '''await page.waitForFunction(() => performance.now() >= 3200);
    const l64 = await page.evaluate(() => ({...Reflect.get(window, "__l64").read(), perf: {...Reflect.get(window, "__perf"), mut:Object.fromEntries(Reflect.get(window,"__perf").mut)}}));
    await writeFile(path.join(artifactDir, `run-${run + 1}.l64.json`), JSON.stringify(l64));
    const metrics = await page.evaluate(() => Reflect.get(window, "__coldLoad").read());''')
Path('scripts/.l64-bench.ts').write_text(p)
