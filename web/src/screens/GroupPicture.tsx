import { useRef } from 'react';
import { makeAvatar } from '../lib/group-avatar';
import { GroupAvatar, Icon, toast } from '../ui';

/**
 * The group picture with a camera badge: tap to pick a picture, × to remove it. Before the group
 * exists (no id) an empty tile stands in for the pattern the group will get.
 */
export function PicturePicker({ groupId, picture, onChange, busy, disabled }: { groupId?: string; picture?: string; onChange: (picture: string) => unknown; busy?: boolean; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const pick = async (f?: File) => {
    if (!f) return;
    try {
      await onChange(await makeAvatar(f));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="pic-picker">
      <button type="button" className="pic-button" onClick={() => input.current?.click()} disabled={disabled || busy} aria-label={picture ? 'Change group picture' : 'Add group picture'} title={picture ? 'Change picture' : 'Add picture'}>
        {groupId || picture ? <GroupAvatar id={groupId ?? ''} picture={picture} size="xl" /> : <span className="avatar square xl pic-empty" aria-hidden="true">{Icon.image(22)}</span>}
        <span className="pic-badge" aria-hidden="true">{busy ? <span className="spinner" /> : Icon.camera()}</span>
      </button>
      {picture && !busy && (
        <button type="button" className="pic-remove" aria-label="Remove group picture" title="Remove picture" disabled={disabled} onClick={() => void Promise.resolve(onChange('')).catch((e) => toast(e instanceof Error ? e.message : String(e)))}>{Icon.close()}</button>
      )}
      <input ref={input} type="file" accept="image/*" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
    </div>
  );
}
