from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    supabase_url: str
    supabase_service_key: str
    api_secret: str = ""
    google_maps_api_key: str = ""
    clozr_ingest_url: str = ""
    clozr_ingest_key: str = ""

    class Config:
        env_file = ".env"

settings = Settings()
