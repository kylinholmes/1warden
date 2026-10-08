param([Parameter(Mandatory=$true)][int]$AppProcessId, [Parameter(Mandatory=$true)][ValidateSet('hotkey','hotkey-message','focus-main','clipboard-equals','clipboard-later','clipboard-meta')][string]$Action, [string]$Expected='')
$ErrorActionPreference='Stop'
$appProcess=Get-Process -Id $AppProcessId
if ($appProcess.ProcessName -ne '1warden') { throw 'Expected an explicitly owned 1warden process' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class QuickProbe {
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint first,uint second,bool attach);
 public delegate bool WindowCallback(IntPtr window, IntPtr data);
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
 [DllImport("user32.dll")] public static extern bool EnumWindows(WindowCallback callback,IntPtr data);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window,out Rect rect);
 public static bool FocusMain(uint process) {
   IntPtr largest=IntPtr.Zero; int width=0;
   EnumWindows((window,data)=> { uint owner; GetWindowThreadProcessId(window,out owner); Rect rect;
     if(owner==process && GetWindowRect(window,out rect) && rect.Right-rect.Left>width) {largest=window;width=rect.Right-rect.Left;} return true; },IntPtr.Zero);
   if(largest==IntPtr.Zero) return false;
   if(SetForegroundWindow(largest)) return true;
   uint ignored; uint foreground=GetWindowThreadProcessId(GetForegroundWindow(),out ignored); uint current=GetCurrentThreadId();
   bool attached=foreground!=current && AttachThreadInput(current,foreground,true);
   try { return SetForegroundWindow(largest); } finally { if(attached)AttachThreadInput(current,foreground,false); }
 }
 [DllImport("user32.dll")] public static extern bool PostThreadMessage(uint id,uint message,UIntPtr w,IntPtr l);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
 [DllImport("user32.dll")] public static extern bool OpenClipboard(IntPtr window);
 [DllImport("user32.dll")] public static extern bool CloseClipboard();
 [DllImport("user32.dll")] public static extern IntPtr GetClipboardData(uint format);
 [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
 [DllImport("user32.dll")] public static extern IntPtr GetClipboardOwner();
 [DllImport("kernel32.dll")] public static extern IntPtr GlobalLock(IntPtr memory);
 [DllImport("kernel32.dll")] public static extern bool GlobalUnlock(IntPtr memory);
 public static bool EqualsText(string expected) {
   if(!OpenClipboard(IntPtr.Zero)) throw new Exception("Clipboard busy");
   try { var handle=GetClipboardData(13); if(handle==IntPtr.Zero) return expected=="";
     var data=GlobalLock(handle); if(data==IntPtr.Zero) throw new Exception("Clipboard inaccessible");
     try { return Marshal.PtrToStringUni(data)==expected; } finally {GlobalUnlock(handle);}
   } finally {CloseClipboard();}
 }
}
'@
switch ($Action) {
 'hotkey' { [void][QuickProbe]::FocusMain([uint32]$AppProcessId); foreach ($thread in $appProcess.Threads) { [void][QuickProbe]::PostThreadMessage([uint32]$thread.Id,0x312,[UIntPtr]::new([uint64]0x434f),[IntPtr]::Zero) }; 'sent' }
 'hotkey-message' { foreach ($thread in $appProcess.Threads) { [void][QuickProbe]::PostThreadMessage([uint32]$thread.Id,0x312,[UIntPtr]::new([uint64]0x434f),[IntPtr]::Zero) }; 'sent' }
 'focus-main' { [QuickProbe]::FocusMain([uint32]$AppProcessId) }
 'clipboard-equals' { [QuickProbe]::EqualsText($Expected).ToString().ToLowerInvariant() }
 'clipboard-later' { Set-Clipboard -Value '1warden-qa-later-copy'; 'set' }
 'clipboard-meta' { $ownerId = [uint32]0; [void][QuickProbe]::GetWindowThreadProcessId([QuickProbe]::GetClipboardOwner(),[ref]$ownerId); @{ sequence=[QuickProbe]::GetClipboardSequenceNumber(); ownerProcess=$ownerId } | ConvertTo-Json -Compress }
}
