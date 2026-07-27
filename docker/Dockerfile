# Build context is this app's own root, so the image builds from a plain clone of this repository.
FROM node:24.18-alpine AS build
RUN npm install -g pnpm@latest
WORKDIR /app
COPY . ./
RUN pnpm install --frozen-lockfile

# Stamped into the about dialog so a user can identify the source matching this build (AGPL-3.0 §13).
ARG VIEWER_COMMIT=dev
ENV VIEWER_COMMIT=$VIEWER_COMMIT
RUN pnpm run build

# Static serving — the viewer is a plain static bundle on its own origin.
FROM nginx:1.27-alpine AS viewer
COPY --from=build /app/dist /usr/share/nginx/html
COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template

# Origin(s) allowed to embed the viewer in an iframe, written into the frame-ancestors CSP header at
# container start. The default blocks embedding, so every real deployment must override it.
ENV FRAME_ANCESTORS="'self'"
EXPOSE 8080
