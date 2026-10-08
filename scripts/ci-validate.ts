#!/usr/bin/env bun
import { resolve } from 'node:path';
import { validateWorkflow } from './ci-policy';
const workflow = Bun.YAML.parse(await Bun.file(resolve(import.meta.dir, '../.github/workflows/build.yml')).text());
const errors = validateWorkflow(workflow);
if (errors.length) throw new Error(`CI policy violations:\n${errors.map(error => `- ${error}`).join('\n')}`);
if (process.argv.includes('--json')) console.log(JSON.stringify(workflow));
else console.log('PASS workflow YAML and pinned-action/least-privilege/test-artifact policy');
