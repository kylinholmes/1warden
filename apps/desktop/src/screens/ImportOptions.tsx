export function ImportOptions({ skipExisting, onChange, disabled }: {
  skipExisting: boolean; onChange: (value: boolean) => void; disabled: boolean;
}) {
  return <div className="my-5 rounded-[var(--radius-md)] bg-[var(--surface-well)] p-4">
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" aria-label="跳过已有条目" checked={skipExisting} disabled={disabled}
        onChange={event => onChange(event.target.checked)} />跳过已有条目
    </label>
    <p className="mt-2 text-xs leading-relaxed text-[var(--ink-secondary)]">比较条目内容和文件夹；同名但密码等内容不同的条目仍会导入。网络中断后，保留此选项重新导入即可补齐剩余条目。</p>
  </div>;
}
