# opencode-cluster wordmark

The name is always **opencode-cluster**, lowercase with a hyphen. Both words use
DynaPuff Bold, with slightly tightened spacing. `cluster` uses a warm accent.

- `wordmark-light.svg`: ink blue and burnt orange for light backgrounds.
- `wordmark-dark.svg`: warm white and peach for dark backgrounds.

Both are transparent, accessible SVGs with outlined lettering. They need no font
download, embedded font, JavaScript or external asset at display time. Keep the
aspect ratio and use the appropriate version for the background.

## Typeface credit

[DynaPuff](https://github.com/googlefonts/dynapuff) was designed by Toshi Omagari
and is distributed under the SIL Open Font License 1.1. The original copyright
notice and license are preserved in [DynaPuff-OFL.txt](DynaPuff-OFL.txt).

The source font is pinned to Google Fonts commit
`d4cc17c373d3c60e98e332099c1462b98305101e`:

[DynaPuff variable font](https://raw.githubusercontent.com/google/fonts/d4cc17c373d3c60e98e332099c1462b98305101e/ofl/dynapuff/DynaPuff%5Bwdth%2Cwght%5D.ttf)

SHA-256: `c3752fc6dd8aaa46a88637f061a9a4e6ab44c02c5f0afd65528b91ae8ff6f948`

## Regenerate

Download the pinned font above, then use Python with `fonttools==4.60.2` installed:

```sh
python packages/cluster/assets/generate.py /path/to/DynaPuff.ttf
```

The generator verifies the font checksum, instantiates weight 700 and width 100,
and writes both SVGs. It is an optional design tool, separate from the application
build.
