{
  "targets": [
    {
      "target_name": "verified_fd_provider",
      "sources": ["native/verified-fd-provider/verified_fd_provider.c"],
      "cflags": ["-std=c11", "-Wall", "-Wextra", "-Werror"],
      "ldflags": ["-pthread"]
    }
  ]
}
