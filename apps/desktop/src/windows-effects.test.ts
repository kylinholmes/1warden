import { expect, it } from 'vitest';
import source from '../src-tauri/tauri.windows.conf.json?raw';
import commonSource from '../src-tauri/tauri.conf.json?raw';

it('does not enable Acrylic before native Windows version detection', () => {
  const config = JSON.parse(source);
  const main = config.app.windows.find((window: { label: string }) => window.label === 'main');
  expect(main.transparent).toBe(true);
  expect(main.windowEffects?.effects ?? []).toEqual([]);
});

it('defers the shadow frame to native OS-version selection without disabling resizing', () => {
  const config = JSON.parse(source);
  const main = config.app.windows.find((window: { label: string }) => window.label === 'main');
  expect(main.shadow).toBe(false);
  expect(main.decorations).toBe(false);
  expect(main.resizable).toBe(true);
});

it.each([source, commonSource])('quick window supports transparent HTML corners', source => {
  const quick = JSON.parse(source).app.windows.find((window: { label?: string }) => window.label === 'quick');
  expect(quick.transparent).toBe(true);
  expect(quick.decorations).toBe(false);
});
