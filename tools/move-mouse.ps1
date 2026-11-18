# Move the mouse cursor to a neutral position (away from window chrome)
Add-Type -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
'@ -Name U -Namespace W
[W.U]::SetCursorPos(400, 950)
