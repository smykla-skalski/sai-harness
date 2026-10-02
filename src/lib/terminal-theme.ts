import type { ITheme } from '@xterm/xterm';

export function terminalTheme(dark: boolean): ITheme {
  return {
    background: dark ? '#151a21' : '#ffffff',
    foreground: dark ? '#f3f6f7' : '#18211f',
    cursor: dark ? '#2dd4bf' : '#0f766e',
    cursorAccent: dark ? '#151a21' : '#ffffff',
    selectionBackground: dark ? '#2b625c' : '#bce8df',
    black: dark ? '#27313b' : '#18211f',
    red: dark ? '#f0a0a6' : '#a33a45',
    green: dark ? '#71cabc' : '#0f766e',
    yellow: dark ? '#e8c07a' : '#8a5d17',
    blue: dark ? '#8db9e3' : '#246197',
    magenta: dark ? '#c6a4e8' : '#7c4c9c',
    cyan: dark ? '#7ed3d5' : '#08757d',
    white: dark ? '#d8e1e6' : '#64736e',
    brightBlack: dark ? '#87939e' : '#53645d',
    brightRed: dark ? '#ffc1c5' : '#8b2f39',
    brightGreen: dark ? '#a5e5d9' : '#08655e',
    brightYellow: dark ? '#f4d89e' : '#704a0d',
    brightBlue: dark ? '#b6d5f2' : '#164f88',
    brightMagenta: dark ? '#dfc1f5' : '#653784',
    brightCyan: dark ? '#b1e8e9' : '#075e65',
    brightWhite: dark ? '#f3f6f7' : '#34443f',
  };
}
