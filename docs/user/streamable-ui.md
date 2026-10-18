# Streamable answer visuals

Assistant replies on web, desktop, and mobile can render metrics, tables,
line, area, grouped/stacked/horizontal bar, pie/donut, radar, radial, scatter and
combined charts, comparison cards, timelines, workflows, UML diagrams,
and reports with tabs or expandable details directly from a fenced `t3-ui` JSONL block. Each line is one complete
JSON object. Tables and charts grow as their row and point records arrive. An
unfinished record stays hidden; completed records remain visible if a response
is interrupted. Closing the fence ends the visual's receiving indicator even
when more answer text follows.

The default paragraph streaming mode releases complete visual record lines
without waiting for the entire fence. The full-response streaming setting still
holds the response until completion. Ordinary code fences keep their existing
buffering behavior.

For example, these explicitly illustrative values render as a table and chart:

````markdown
```t3-ui
{"type":"metric","id":"latest","label":"Illustrative latest value","value":"121 USD"}
{"type":"table","id":"values","title":"Illustrative values","columns":["Day","USD"]}
{"type":"row","id":"values","cells":["Day 1",120]}
{"type":"row","id":"values","cells":["Day 2",123]}
{"type":"row","id":"values","cells":["Day 3",121]}
{"type":"chart","id":"trend","title":"Illustrative trend","xLabel":"Day","yLabel":"USD"}
{"type":"point","id":"trend","label":"Day 1","value":120}
{"type":"point","id":"trend","label":"Day 2","value":123}
{"type":"point","id":"trend","label":"Day 3","value":121}
```
````

Component declarations may include `sources`, an array of
`{"label":"Source name","url":"https://example.com/page"}` objects. Agents must
verify their data and source URLs; the renderer validates links but does not
verify the claims. Exact chart values are available in **View data**, including a CSV copy button.
Hover, focus or tap a chart to compare all series at the same category.

This is a local bounded JSONL protocol, not OpenUI Lang or the Thesys runtime.
It does not execute generated JavaScript or HTML. Each block is limited to
128,000 characters, 512 records, 24 components, 200 rows or points per component,
and 12 table columns. Charts support up to 8 series and reports up to 12 sections.
Unsupported records expose the source fallback while supported records continue
to render. Existing metrics, tables, and single-series charts remain compatible.

For comparisons, ask for a chart with named series or cards with the same facts
for each option. Chart legends let you show or hide individual series without
losing the exact values in **View data**. For a sequence, ask for a timeline;
for branching dependencies, ask for a workflow. Ask for report tabs when you
want to switch between topics, or expandable details for supporting material.
New data keeps the current tab, chart selection, and open details while the
reply streams. Reloading history restores the content; interaction choices
start from their defaults.

Ask for sequence, class, state, use-case or activity UML diagrams when you need
software interactions, structure or control flow. They grow through complete
notation snapshots as the answer arrives; a cancelled or invalid update keeps
the last valid diagram. Zoom and pan preserve readable text on narrow screens.
Diagrams render privately on the connected environment without an external
rendering service. **View notation** exposes the source; includes, external
resources and custom styling are unsupported. Older environments may need an
update to render UML.
