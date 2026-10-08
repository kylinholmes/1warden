# Read-only native checks against an explicitly supplied, disposable 1Warden process.
# Run this while its main window is restored (not maximized).
param([Parameter(Mandatory=$true)][int]$AppProcessId)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OneWardenFrameProbe {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr window, ref Point point);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
    public static int HitTest(IntPtr window, int x, int y) {
        UIntPtr result;
        var point = new IntPtr(unchecked((y << 16) | (x & 0xffff)));
        if (SendMessageTimeout(window, 0x84, IntPtr.Zero, point, 2, 2000, out result) == IntPtr.Zero)
            throw new Exception("WM_NCHITTEST timed out");
        return unchecked((int)result.ToUInt64());
    }
}
'@
$appProcess = Get-Process -Id $AppProcessId
if ($appProcess.ProcessName -ne '1warden') { throw 'Only an explicitly supplied 1warden test process is supported' }
$appWindow = $appProcess.MainWindowHandle
[uint32]$windowOwner = 0
[void][OneWardenFrameProbe]::GetWindowThreadProcessId($appWindow, [ref]$windowOwner)
if ($appWindow -eq [IntPtr]::Zero -or $windowOwner -ne $AppProcessId -or -not [OneWardenFrameProbe]::IsWindowVisible($appWindow)) { throw 'Missing visible main window of the supplied process' }
if ([OneWardenFrameProbe]::IsZoomed($appWindow)) { throw 'Restore the test window before checking its resize frame' }
$previousDpi = [OneWardenFrameProbe]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
try {
    $outer = [OneWardenFrameProbe+Rect]::new()
    $inner = [OneWardenFrameProbe+Rect]::new()
    $origin = [OneWardenFrameProbe+Point]::new()
    if (-not [OneWardenFrameProbe]::GetWindowRect($appWindow,[ref]$outer) -or
        -not [OneWardenFrameProbe]::GetClientRect($appWindow,[ref]$inner) -or
        -not [OneWardenFrameProbe]::ClientToScreen($appWindow,[ref]$origin)) { throw 'Unable to query native window bounds' }
    $insets = @(($origin.X - $outer.Left), ($origin.Y - $outer.Top),
        ($outer.Right - $origin.X - $inner.Right), ($outer.Bottom - $origin.Y - $inner.Bottom))
    if (@($insets | Where-Object { $_ -ne 0 }).Count -ne 0) { throw "Extra native blur frame (left/top/right/bottom): $insets" }
    $midX = [int](($outer.Left + $outer.Right) / 2)
    $midY = [int](($outer.Top + $outer.Bottom) / 2)
    $points = @(
        @('left', ($outer.Left + 1), $midY, 10),
        @('right', ($outer.Right - 2), $midY, 11),
        @('top', $midX, ($outer.Top + 1), 12),
        @('bottom', $midX, ($outer.Bottom - 2), 15),
        @('top-left', ($outer.Left + 1), ($outer.Top + 1), 13),
        @('top-right', ($outer.Right - 2), ($outer.Top + 1), 14),
        @('bottom-left', ($outer.Left + 1), ($outer.Bottom - 2), 16),
        @('bottom-right', ($outer.Right - 2), ($outer.Bottom - 2), 17)
    )
    foreach ($point in $points) {
        $hit = [OneWardenFrameProbe]::HitTest($appWindow, $point[1], $point[2])
        if ($hit -ne $point[3]) { throw "Resize hit test $($point[0]): expected $($point[3]), got $hit" }
    }
    [pscustomobject]@{ passed=$true; insets=$insets; resizeEdgesAndCorners=$points.Count } | ConvertTo-Json -Compress
} finally {
    [void][OneWardenFrameProbe]::SetThreadDpiAwarenessContext($previousDpi)
}
