# Artwork license

The character artwork of Shiro is **not** covered by the MIT license of the source
code. It is licensed separately under
**[Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)](https://creativecommons.org/licenses/by-nc/4.0/)**.

## What this covers

| Path | What it is |
|---|---|
| `avatar/shiro_base.png` | The base illustration of Shiro |
| `avatar/seethrough/out/` | The layer decomposition of that illustration |
| `avatar/layers/` | The 21 cleaned-up layers the avatar is drawn from |
| `avatar/mouth-mask*.png` | Masks derived from the illustration |
| `avatar/mesh/built/` | Mesh-engine layers and sprites derived from the illustration |
| `docs/images/` | Images rendered from the artwork for this documentation |

## In plain words

You may:

- look at it, share it, and use it in non-commercial projects (a personal assistant,
  a fan project, a tutorial, a demo of your own fork),
- adapt it, as long as you say what you changed.

You must:

- **credit** the original: "Shiro, by smandylee" with a link to this repository.

You may not:

- use it commercially (selling it, putting it in a paid product, using it to
  advertise something) without asking first.

If you only want the code, replace the artwork with your own character: nothing in
the code depends on this particular character, only on the layer names listed in
`avatar/layers/layers.json`.

## How the artwork was made

The base illustration was generated with [NovelAI](https://novelai.net/) and then
decomposed into layers with [See-through](https://github.com/shitagaki-lab/see-through)
(Apache-2.0). Both tools have their own terms of use; if you reuse the artwork,
those terms apply as well.

## Not covered here

`avatar/mesh/` contains the engine of
[mesh-avatar-studio](https://github.com/shinshin86/mesh-avatar-studio) (MIT),
with local changes listed in `avatar/mesh/README.md`. Its license is in
`avatar/mesh/LICENSE-mesh-avatar-studio`.
