# frozen_string_literal: true
require "test_helper"
require "shopify-cli/theme/config"
require "shopify-cli/theme/development_theme"

module ShopifyCli
  module Theme
    class DevelopmentThemeTest < Minitest::Test
      def setup
        super
        config = Config.from_path(ShopifyCli::ROOT + "/test/fixtures/theme")
        @ctx = TestHelpers::FakeContext.new(root: config.root)
        @theme = DevelopmentTheme.new(@ctx, config)
        ShopifyCli::DB.stubs(:del).with(:acting_as_shopify_organization)
      end

      def test_creates_development_theme_if_missing_from_storage
        shop = "dev-theme-server-store.myshopify.com"
        theme_name = "Development (5676d8-theme-dev)"

        ShopifyCli::AdminAPI.stubs(:get_shop).returns(shop)
        ShopifyCli::DB.stubs(:get).with(:development_theme_id).returns(nil)
        ShopifyCli::DB.expects(:set).with(development_theme_id: "12345678")
        @theme.stubs(:name).returns(theme_name)

        ShopifyCli::AdminAPI.expects(:rest_request).with(
          @ctx,
          shop: shop,
          path: "themes.json",
          method: "POST",
          body: JSON.generate({
            theme: {
              name: theme_name,
              role: "development",
            },
          }),
          api_version: "unstable",
        ).returns([
          201,
          "theme" => {
            "id" => "12345678",
          },
        ])

        @theme.ensure_exists!
      end

      def test_creates_development_theme_if_missing_from_api
        shop = "dev-theme-server-store.myshopify.com"
        theme_name = "Development (5676d8-theme-dev)"
        theme_id = "12345678"

        ShopifyCli::AdminAPI.stubs(:get_shop).returns(shop)
        ShopifyCli::DB.stubs(:get).with(:development_theme_id).returns(theme_id)
        ShopifyCli::DB.expects(:set).with(development_theme_id: "12345678")
        @theme.stubs(:name).returns(theme_name)

        ShopifyCli::AdminAPI.expects(:rest_request).with(
          @ctx,
          shop: shop,
          path: "themes/#{theme_id}.json",
          api_version: "unstable",
        ).raises(ShopifyCli::API::APIRequestNotFoundError)

        ShopifyCli::AdminAPI.expects(:rest_request).with(
          @ctx,
          shop: shop,
          path: "themes.json",
          method: "POST",
          body: JSON.generate({
            theme: {
              name: theme_name,
              role: "development",
            },
          }),
          api_version: "unstable",
        ).returns([
          201,
          "theme" => {
            "id" => "12345678",
          },
        ])

        @theme.ensure_exists!
      end

      def test_name_is_generated_unless_exists_in_db
        hostname = "theme-dev.lan"
        hash = "5676d"
        theme_name = "Development (#{hash}-#{hostname.split(".").shift})"

        ShopifyCli::DB.stubs(:get).with(:development_theme_name).returns(nil)
        SecureRandom.expects(:hex).returns(hash)
        Socket.expects(:gethostname).returns(hostname)
        ShopifyCli::DB.expects(:set).with(development_theme_name: theme_name)

        assert_equal(theme_name, @theme.name)
      end

      def test_delete
        shop = "dev-theme-server-store.myshopify.com"
        theme_id = "12345678"

        ShopifyCli::AdminAPI.stubs(:get_shop).returns(shop)
        ShopifyCli::DB.stubs(:get).with(:development_theme_id).returns(theme_id)
        ShopifyCli::DB.stubs(:exists?).with(:development_theme_id).returns(true)
        ShopifyCli::DB.stubs(:del).with(:development_theme_id)
        ShopifyCli::DB.stubs(:exists?).with(:development_theme_name).returns(true)
        ShopifyCli::DB.stubs(:del).with(:development_theme_name)

        @theme.expects(:exists?).returns(true)

        ShopifyCli::AdminAPI.expects(:rest_request).with(
          @ctx,
          shop: shop,
          path: "themes/#{theme_id}.json",
          method: "DELETE",
          api_version: "unstable",
        )

        @theme.delete
      end
    end
  end
end
