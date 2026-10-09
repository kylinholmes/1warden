/** Repository-specific workflow invariants, independent from the YAML parser/runtime. */
export function validateWorkflow(workflow: any): string[] {
  const errors: string[] = [];
  const require = (condition: unknown, message: string) => { if (!condition) errors.push(message); };
  require(workflow?.permissions?.contents === 'read' && Object.keys(workflow?.permissions ?? {}).length === 1, 'Default permissions must be contents: read only');
  require(workflow?.on && 'pull_request' in workflow.on && !('pull_request_target' in workflow.on), 'PR checks must use pull_request, not privileged pull_request_target');
  for (const key of ['BUN_VERSION', 'NODE_VERSION', 'RUST_VERSION']) require(/^\d+\.\d+\.\d+$/.test(workflow?.env?.[key] ?? ''), `${key} must be an exact version`);
  for (const [name, job] of Object.entries<any>(workflow?.jobs ?? {})) {
    require(!JSON.stringify(job.env ?? {}).match(/\$\{\{[^}]*\brunner\./), `${name}: runner context belongs in step env, not job env`);
    if (name !== 'release') require(!job.permissions || Object.values(job.permissions).every(value => value === 'read' || value === 'none'), `${name}: non-release jobs cannot request write permissions`);
    for (const step of job.steps ?? []) {
      if (!step.uses) continue;
      require(/^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/.test(step.uses), `${name}: actions must be pinned to full commit SHAs`);
      if (step.uses.startsWith('actions/checkout@')) require(step.with?.['persist-credentials'] === false, `${name}: checkout must not persist credentials`);
    }
  }
  const ui = workflow?.jobs?.ui, windows = workflow?.jobs?.windows;
  require(ui?.['runs-on'] === 'windows-2022' && windows?.['runs-on'] === 'windows-2022', 'UI/native checks must use the explicitly selected Windows runner');
  require(ui?.strategy?.matrix?.suite?.includes('ui') && ui?.strategy?.matrix?.suite?.includes('extensions'), 'UI matrix must cover shared UI and real extensions');
  require(ui?.strategy?.['fail-fast'] === false, 'UI matrix must preserve independent failures');
  for (const [name, job] of [['ui', ui], ['windows', windows]] as const) {
    require(!JSON.stringify(job ?? {}).includes('secrets.'), `${name}: smoke jobs cannot reference secrets`);
    const reports = job?.steps?.filter((step: any) => step.uses?.startsWith('actions/upload-artifact@') && step.with?.name?.startsWith('test-results-')) ?? [];
    require(reports.length === 1 && reports[0].if === 'always()', `${name}: evidence upload must run even on failures`);
    require(reports[0]?.with?.path?.includes('runner.temp'), `${name}: evidence must come from the dedicated runner temp output`);
  }
  const windowsCommands = (windows?.steps ?? []).map((step: any) => step.run ?? '').join('\n');
  require(windowsCommands.includes('bun run test:windows'), 'Windows release executable must pass native smoke');
  require(windowsCommands.includes('windows-x64-portable.exe') && windowsCommands.includes('Get-FileHash'), 'Windows artifacts must include a checksummed portable executable');
  require(workflow?.jobs?.release?.needs?.includes('ui'), 'Releases must wait for automated UI/extension checks');
  const real = workflow?.jobs?.vaultwarden;
  const service = real?.services?.vaultwarden;
  require(real?.['runs-on'] === 'ubuntu-24.04', 'Real Vaultwarden checks must use the isolated Ubuntu runner');
  require(service?.image === 'vaultwarden/server:1.37.4', 'Real Vaultwarden service must pin 1.37.4');
  require(service?.ports?.length === 1 && service.ports[0] === '127.0.0.1:18083:80', 'Real Vaultwarden must expose only the loopback test port');
  require(!service?.volumes && !JSON.stringify(real ?? {}).includes('secrets.'), 'Real Vaultwarden cannot mount retained data or use secrets');
  require(service?.env?.SIGNUPS_ALLOWED === 'true' && service?.env?.SIGNUPS_VERIFY === 'false', 'Disposable Vaultwarden must allow no-mail test registration');
  require(real?.steps?.some((step: any) => step.run === 'bun run test:vaultwarden'), 'Real Vaultwarden protocol smoke must run');
  const realReports = real?.steps?.filter((step: any) => step.uses?.startsWith('actions/upload-artifact@')) ?? [];
  require(realReports.length === 1 && realReports[0].if === 'always()'
    && realReports[0].with?.path === '${{ runner.temp }}/1warden-ci-vaultwarden/vaultwarden-report.json',
  'Real Vaultwarden evidence must be credential-free JSON, never service database/logs');
  require(workflow?.jobs?.release?.needs?.includes('vaultwarden'), 'Releases must wait for real Vaultwarden checks');
  return errors;
}
