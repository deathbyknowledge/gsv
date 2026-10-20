# Interface language

`locale.ts` owns the active interface language. Before sign-in it follows this
device's languages; once the session is ready, `AppProviders` applies the
signed-in human's `users/{uid}/locale/language` preference. A preference without
a catalog falls back to the device's languages, then English. A change updates
rendered text in place, so drafts survive it.

English in `en.ts` is the source catalog. Every translation supplies the same
keys, and `tsc` rejects an unknown key or a plural message without its `count`.
A test checks that each translation keeps every English `{slot}` and uses only
its language's plural forms. A catalog's header states its conventions, such as
the form of address.

Spanish in `es.ts` is the first translation. English is part of every bundle;
a translation is fetched only when the interface switches to it, and each entry
point renders its first screen once its language is in place.

Development builds include the pseudo-locale `en-XA`. Choose `en-XA` as the
language preference, or as the browser's language, to accent, bracket and
lengthen catalog text: plain text bypassed the catalog, and clipped text needs
more room. The mock gateway (`?mock=1`) keeps the language preference in the
browser, so **Settings → Preferences → Language** switches between `en`, `es`
and `en-XA` there too.

## Writing interface text

- Components call `useT()`, including `memo` components, so a language change
  re-renders them. Plain modules import `t`.
- State and data hold message keys (`TextKey`) and translate where they render.
  Never persist translated text or hand it to another screen, such as a
  sign-out reason.
- Each message is a complete sentence or label. Values fill `{name}` slots
  instead of joining fragments; `rich` places a link or element in a sentence.
- A message with a count has plural forms and takes `count`. Numbers are
  formatted before they are passed.
- Display text never drives logic. Compare codes and translate their labels.
- Text the model reads stays English and never goes through `t`: prompts, task
  text built for a process, tool results and Kernel messages. Error details
  from the Kernel are shown as sent.
- Names the interface does not own, such as the shortcut names Ship Desktop
  registers, are passed as values rather than translated.
