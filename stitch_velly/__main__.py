from __future__ import annotations

from . import service

try:
    from autoreg.plugin.rpc import RpcPluginServer
except ImportError:
    from ._vendor.rpc_server import RpcPluginServer


def initialize(params: dict) -> dict:
    service.configure(str(params.get("data_dir", "")))
    return {
        "plugin_id": params.get("plugin_id", "stitch-velly"),
        "db_path": params.get("db_path", ""),
        "data_dir": params.get("data_dir", ""),
        "capabilities": [],
    }


def main() -> None:
    server = RpcPluginServer()
    server.set_init_handler(initialize)
    server.register("health_check", lambda params: service.health_check())
    server.register("start_bridge", lambda params: service.start(params))
    server.register("stop_bridge", lambda params: service.stop())
    server.register("get_status", lambda params: service.status())
    server.register("get_model_view", service.model_view)
    server.register("get_summary", lambda params: service.summary())
    server.register("refresh_catalog", lambda params: service.launch("refresh_catalog"))
    server.register("probe_model", lambda params: service.launch("probe_model", params))
    server.register("action_status", lambda params: service.action_status())
    server.register("export_opencode", service.export_opencode)
    server.register("get_connection", lambda params: service.connection_info())
    server.register("export_secrets", service.export_secrets)
    server.register("export_gateway_config", lambda params: service.gateway_config())
    server.register("get_gateway_provider", lambda params: service.gateway_provider())
    try:
        server.serve()
    finally:
        service.stop(disable=False)


if __name__ == "__main__":
    main()
