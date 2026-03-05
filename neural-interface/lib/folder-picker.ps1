param([string]$Title = 'Select a folder')

Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

[ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
class FileOpenDialogRCW {}

[ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
}

[ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IFileOpenDialog {
    [PreserveSig] uint Show(IntPtr hwndOwner);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
    void AddPlace(IShellItem psi, int fdap);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
    void Close(int hr);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr pFilter);
    void GetResults(out IntPtr ppenum);
    void GetSelectedItems(out IntPtr ppsai);
}

public static class FolderPicker {
    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    public static string Pick(string title) {
        // Grab the currently focused window (the browser) so the dialog opens on top of it
        IntPtr foreground = GetForegroundWindow();

        var dlg = (IFileOpenDialog)new FileOpenDialogRCW();
        dlg.SetOptions(0x20); // FOS_PICKFOLDERS
        if (!string.IsNullOrEmpty(title)) dlg.SetTitle(title);
        uint hr = dlg.Show(foreground);
        if (hr != 0) return string.Empty;
        IShellItem item;
        dlg.GetResult(out item);
        string path;
        item.GetDisplayName(0x80058000, out path); // SIGDN_DESKTOPABSOLUTEPARSING
        return path ?? string.Empty;
    }
}
'@ -ReferencedAssemblies System.Windows.Forms

$result = [FolderPicker]::Pick($Title)
if ($result) { Write-Output $result }
