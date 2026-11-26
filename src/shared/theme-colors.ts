export type InterfaceTheme = 'light' | 'dark'

export type InterfaceThemeColors = {
  backgroundPrimary: string
  backgroundSecondary: string
  backgroundTertiary: string
  brand: string
}

export type InterfaceColors = Record<InterfaceTheme, InterfaceThemeColors>

export type InterfaceColorPreset = {
  id: string
  label: string
  colors: InterfaceColors
}

export const DEFAULT_INTERFACE_COLORS: InterfaceColors = {
  light: {
    backgroundPrimary: '#ffffff',
    backgroundSecondary: '#f3f3f3',
    backgroundTertiary: '#dee2e6',
    brand: '#228be6',
  },
  dark: {
    backgroundPrimary: '#242424',
    backgroundSecondary: '#3b3b3b',
    backgroundTertiary: '#424242',
    brand: '#228be6',
  },
}

// Colors from Lamina's web palette. Browser chat and the Appearance preset share them.
export const LAMINA_PALETTE = {
  light: {
    background: '#f9fafb',
    surface: '#ffffff',
    raised: '#f7f7f7',
    border: '#dee5ee',
    subtleBorder: '#eeeeee',
    ink: '#221e1f',
    softInk: '#303030',
    muted: '#6f6f6f',
    accent: '#10b981',
    accentHover: '#0c8a60',
    accentInk: '#052e20',
    accentText: '#0c8a60',
    accentTint: '#ecfdf5',
    focus: '#405de6',
    danger: '#b01a2e',
    warning: '#8a5a00',
    code: '#1b1f23',
    codeInk: '#e6e9ec',
  },
  dark: {
    background: '#0e1113',
    surface: '#161a1d',
    raised: '#1d2226',
    border: '#2a3036',
    subtleBorder: '#22272c',
    ink: '#eef1f3',
    softInk: '#c7cdd3',
    muted: '#8e979f',
    accent: '#34d399',
    accentHover: '#4ade80',
    accentInk: '#052e20',
    accentText: '#4ade80',
    accentTint: 'rgba(52,211,153,.12)',
    focus: '#7b93ff',
    danger: '#ff8a98',
    warning: '#f8c96a',
    code: '#0a0c0e',
    codeInk: '#e6e9ec',
  },
} as const

function laminaInterfaceColors(theme: InterfaceTheme): InterfaceThemeColors {
  const palette = LAMINA_PALETTE[theme]
  return {
    backgroundPrimary: palette.background,
    backgroundSecondary: palette.surface,
    backgroundTertiary: palette.raised,
    brand: palette.accent,
  }
}

export const LAMINA_INTERFACE_COLORS: InterfaceColors = {
  light: laminaInterfaceColors('light'),
  dark: laminaInterfaceColors('dark'),
}

export function matchesLaminaColors(colors: InterfaceThemeColors, theme: InterfaceTheme): boolean {
  const lamina = LAMINA_INTERFACE_COLORS[theme]
  const primary = colors.backgroundPrimary.toLowerCase()
  const secondary = colors.backgroundSecondary.toLowerCase()
  // The first Lamina preset stored these two surfaces in the opposite order.
  const matchesSurfaces =
    (primary === lamina.backgroundPrimary && secondary === lamina.backgroundSecondary) ||
    (primary === lamina.backgroundSecondary && secondary === lamina.backgroundPrimary)
  return (
    matchesSurfaces &&
    colors.backgroundTertiary.toLowerCase() === lamina.backgroundTertiary &&
    colors.brand.toLowerCase() === lamina.brand
  )
}

export const INTERFACE_COLOR_PRESETS = [
  {
    id: 'default',
    label: 'Default',
    colors: DEFAULT_INTERFACE_COLORS,
  },
  {
    id: 'lamina',
    label: 'Lamina',
    colors: LAMINA_INTERFACE_COLORS,
  },
  {
    id: 'claude-classic',
    label: 'Claude Classic',
    colors: {
      light: {
        backgroundPrimary: '#f7f6f2',
        backgroundSecondary: '#eeede7',
        backgroundTertiary: '#e2e1db',
        brand: '#d97757',
      },
      dark: {
        backgroundPrimary: '#262624',
        backgroundSecondary: '#333330',
        backgroundTertiary: '#41413d',
        brand: '#e89173',
      },
    },
  },
  {
    id: 'mist-blue',
    label: 'Mist Blue',
    colors: {
      light: {
        backgroundPrimary: '#f6f8fa',
        backgroundSecondary: '#eaf0f5',
        backgroundTertiary: '#d9e3ec',
        brand: '#5784aa',
      },
      dark: {
        backgroundPrimary: '#1c252e',
        backgroundSecondary: '#253240',
        backgroundTertiary: '#324252',
        brand: '#7fb3dd',
      },
    },
  },
] satisfies ReadonlyArray<InterfaceColorPreset>

export function getDefaultInterfaceColors(): InterfaceColors {
  return {
    light: { ...DEFAULT_INTERFACE_COLORS.light },
    dark: { ...DEFAULT_INTERFACE_COLORS.dark },
  }
}

export function isInterfaceBrandColorAllowed(color: string): boolean {
  return color.toLowerCase() !== '#ffffff'
}

export function resolveInterfaceBrandColor(color: string, theme: InterfaceTheme): string {
  return isInterfaceBrandColorAllowed(color) ? color : DEFAULT_INTERFACE_COLORS[theme].brand
}

export function resolveInterfaceBrandColors(colors: InterfaceColors): InterfaceColors {
  return {
    light: { ...colors.light, brand: resolveInterfaceBrandColor(colors.light.brand, 'light') },
    dark: { ...colors.dark, brand: resolveInterfaceBrandColor(colors.dark.brand, 'dark') },
  }
}

export function renameInterfaceColorPreset(
  presets: InterfaceColorPreset[],
  presetId: string,
  label: string
): InterfaceColorPreset[] {
  const trimmedLabel = label.trim()
  if (!trimmedLabel) return presets

  return presets.map((preset) => (preset.id === presetId ? { ...preset, label: trimmedLabel } : preset))
}

export function withColorOpacity(color: string, opacity: number): string {
  const alpha = Math.round(Math.min(Math.max(opacity, 0), 1) * 255)
  return `${color}${alpha.toString(16).padStart(2, '0')}`
}
