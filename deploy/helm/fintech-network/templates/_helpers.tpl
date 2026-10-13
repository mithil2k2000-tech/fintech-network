{{- define "fn.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Every resource is named <release>-<component>. */}}
{{- define "fn.fullname" -}}
{{- .Release.Name | trunc 40 | trimSuffix "-" -}}
{{- end -}}

{{- define "fn.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
app.kubernetes.io/name: {{ include "fn.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* Call with (dict "root" $ "component" "api"). */}}
{{- define "fn.selectorLabels" -}}
app.kubernetes.io/name: {{ include "fn.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* Call with (dict "root" $ "name" "api"). */}}
{{- define "fn.image" -}}
{{- $img := .root.Values.image -}}
{{- if $img.registry -}}{{ $img.registry }}/{{- end -}}
{{ $img.repositoryPrefix }}/{{ .name }}:{{ $img.tag }}
{{- end -}}

{{- define "fn.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{ .Values.secrets.existingSecret }}
{{- else -}}
{{ include "fn.fullname" . }}-secrets
{{- end -}}
{{- end -}}

{{- define "fn.postgresHost" -}}
{{ include "fn.fullname" . }}-postgres
{{- end -}}

{{- define "fn.databaseUrl" -}}
{{- if .Values.postgresql.enabled -}}
{{- $pg := .Values.postgresql -}}
postgres://{{ $pg.username }}:{{ required "postgresql.password is required" $pg.password | urlquery }}@{{ include "fn.postgresHost" . }}:5432/{{ $pg.database }}
{{- else -}}
{{ required "externalDatabase.url is required when postgresql.enabled is false" .Values.externalDatabase.url }}
{{- end -}}
{{- end -}}

{{/* The origins the API accepts: one per front end host. */}}
{{- define "fn.allowedOrigins" -}}
{{- $scheme := ternary "https" "http" .Values.ingress.tls.enabled -}}
{{- $origins := list -}}
{{- range .Values.web.apps -}}
{{- $origins = append $origins (printf "%s://%s" $scheme .host) -}}
{{- end -}}
{{ join "," $origins }}
{{- end -}}

{{- define "fn.podSecurityContext" -}}
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{/* For the API and migration containers: no root, no writes, no extra powers. */}}
{{- define "fn.apiContainerSecurityContext" -}}
runAsNonRoot: true
runAsUser: 1000
runAsGroup: 1000
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end -}}
