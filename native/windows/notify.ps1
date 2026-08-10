param(
    [Parameter(Mandatory = $false, Position = 0)]
    [string]$Payload = ""
)

$ErrorActionPreference = 'Stop'
$appId = 'com.opencodex.notifier'

function Get-PayloadData {
    param([string]$Base64)
    if (-not $Base64) { return $null }
    try {
        $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Base64))
        return ($json | ConvertFrom-Json)
    } catch {
        return $null
    }
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential, Pack = 4)]
public struct OpencodexPropertyKey {
    public Guid fmtid;
    public uint pid;
    public OpencodexPropertyKey(Guid fmtid, uint pid) { this.fmtid = fmtid; this.pid = pid; }
}

[StructLayout(LayoutKind.Explicit)]
public struct OpencodexPropVariant {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr pointerValue;
}

[ComImport]
[Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IOpencodexPropertyStore {
    [PreserveSig] int GetCount(out uint cProps);
    [PreserveSig] int GetAt(uint iProp, out OpencodexPropertyKey pkey);
    [PreserveSig] int GetValue(ref OpencodexPropertyKey key, out OpencodexPropVariant pv);
    [PreserveSig] int SetValue(ref OpencodexPropertyKey key, ref OpencodexPropVariant pv);
    [PreserveSig] int Commit();
}

public static class OpencodexShortcut {
    private const int GPS_READWRITE = 2;
    private static readonly Guid PKEY_AppUserModelID = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHGetPropertyStoreFromParsingName(
        string pszPath, IntPtr pbc, int flags, ref Guid riid, out IOpencodexPropertyStore ppv);

    public static void SetAppUserModelId(string shortcutPath, string appId) {
        IOpencodexPropertyStore store;
        Guid iid = typeof(IOpencodexPropertyStore).GUID;
        int hr = SHGetPropertyStoreFromParsingName(shortcutPath, IntPtr.Zero, GPS_READWRITE, ref iid, out store);
        if (hr != 0) throw new COMException("SHGetPropertyStoreFromParsingName failed", hr);
        OpencodexPropVariant value = new OpencodexPropVariant { vt = 31, pointerValue = Marshal.StringToCoTaskMemUni(appId) };
        try {
            hr = store.SetValue(ref PKEY_AppUserModelID, ref value);
            if (hr != 0) throw new COMException("SetValue failed", hr);
            hr = store.Commit();
            if (hr != 0) throw new COMException("Commit failed", hr);
        } finally {
            Marshal.FreeCoTaskMem(value.pointerValue);
            Marshal.ReleaseComObject(store);
        }
    }
}
'@

$data = Get-PayloadData $Payload
if (-not $data) {
    Write-Error 'No payload received.'
    exit 1
}

$title = [string]$data.title
if (-not $title) { $title = 'Opencodex' }
$body = [string]$data.body
$iconPath = [string]$data.icon
$uriScheme = [string]$data.uri
if (-not $uriScheme) {
    if ($env:TERM_PROGRAM -eq 'vscode-insiders') { $uriScheme = 'vscode-insiders://' } else { $uriScheme = 'vscode://' }
}

try {
    $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
    $lnkPath = Join-Path $startMenu 'Opencodex.lnk'
    if (-not (Test-Path $startMenu)) {
        New-Item -ItemType Directory -Path $startMenu -Force | Out-Null
    }

    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($lnkPath)
    $shortcut.TargetPath = Join-Path $env:WINDIR 'explorer.exe'
    $shortcut.WorkingDirectory = $env:WINDIR
    $shortcut.Description = 'Opencodex notifications'
    if ($iconPath -and (Test-Path $iconPath)) {
        $shortcut.IconLocation = "$iconPath,0"
    }
    $shortcut.Save()
    [OpencodexShortcut]::SetAppUserModelId($lnkPath, $appId)

    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

    $safeTitle = [System.Security.SecurityElement]::Escape($title)
    $safeBody = [System.Security.SecurityElement]::Escape($body)

    $xmlBuilder = New-Object System.Text.StringBuilder
    [void]$xmlBuilder.Append('<toast activationType="protocol" launch="' + $uriScheme + '">')
    [void]$xmlBuilder.Append('<visual>')
    [void]$xmlBuilder.Append('<binding template="ToastGeneric">')
    if ($iconPath -and (Test-Path $iconPath)) {
        $imageUri = (New-Object System.Uri($iconPath)).AbsoluteUri
        [void]$xmlBuilder.Append('<image placement="appLogoOverride" src="' + $imageUri + '" hint-crop="circle"/>')
    }
    [void]$xmlBuilder.Append('<text>' + $safeTitle + '</text>')
    [void]$xmlBuilder.Append('<text>' + $safeBody + '</text>')
    [void]$xmlBuilder.Append('</binding>')
    [void]$xmlBuilder.Append('</visual>')
    [void]$xmlBuilder.Append('<actions>')
    [void]$xmlBuilder.Append('<action content="Open" activationType="protocol" arguments="' + $uriScheme + '"/>')
    [void]$xmlBuilder.Append('</actions>')
    [void]$xmlBuilder.Append('</toast>')

    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml($xmlBuilder.ToString())

    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
    $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
    $notifier.Show($toast)
    exit 0
} catch {
    Write-Error $_
    exit 1
}
