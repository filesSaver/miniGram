{{/*
  _helpers.tpl — Shared Helm template helpers
  ─────────────────────────────────────────────────────────────────────────────
  These macros are called throughout all templates to generate consistent
  names, labels, and selectors. Using helpers avoids copy-paste errors and
  makes renaming the chart easy (change it once here, not in 20 files).
*/}}

{{/* Full chart name (used as a prefix for resource names) */}}
{{- define "minigram.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Standard labels applied to every resource */}}
{{- define "minigram.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/* Selector labels for a specific component (used in matchLabels + pod labels) */}}
{{- define "minigram.selectorLabels" -}}
app.kubernetes.io/name: {{ include "minigram.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}
