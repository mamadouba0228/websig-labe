<?xml version="1.0" encoding="UTF-8"?>
<StyledLayerDescriptor version="1.0.0" xmlns="http://www.opengis.net/sld" xmlns:ogc="http://www.opengis.net/ogc"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.opengis.net/sld http://schemas.opengis.net/sld/1.0.0/StyledLayerDescriptor.xsd">
  <NamedLayer>
    <Name>labe_routes</Name>
    <UserStyle>
      <Title>Voirie par type</Title>
      <FeatureTypeStyle>
        <Rule>
          <Title>Voie rapide</Title>
          <ogc:Filter><ogc:PropertyIsEqualTo><ogc:PropertyName>nature</ogc:PropertyName><ogc:Literal>Voie rapide</ogc:Literal></ogc:PropertyIsEqualTo></ogc:Filter>
          <LineSymbolizer><Stroke><CssParameter name="stroke">#c8102e</CssParameter><CssParameter name="stroke-width">5</CssParameter></Stroke></LineSymbolizer>
        </Rule>
        <Rule>
          <Title>Route primaire</Title>
          <ogc:Filter><ogc:PropertyIsEqualTo><ogc:PropertyName>nature</ogc:PropertyName><ogc:Literal>Route primaire</ogc:Literal></ogc:PropertyIsEqualTo></ogc:Filter>
          <LineSymbolizer><Stroke><CssParameter name="stroke">#e8590c</CssParameter><CssParameter name="stroke-width">4.5</CssParameter></Stroke></LineSymbolizer>
        </Rule>
        <Rule>
          <Title>Route secondaire</Title>
          <ogc:Filter><ogc:PropertyIsEqualTo><ogc:PropertyName>nature</ogc:PropertyName><ogc:Literal>Route secondaire</ogc:Literal></ogc:PropertyIsEqualTo></ogc:Filter>
          <LineSymbolizer><Stroke><CssParameter name="stroke">#f08c00</CssParameter><CssParameter name="stroke-width">4</CssParameter></Stroke></LineSymbolizer>
        </Rule>
        <Rule>
          <Title>Route tertiaire</Title>
          <ogc:Filter><ogc:PropertyIsEqualTo><ogc:PropertyName>nature</ogc:PropertyName><ogc:Literal>Route tertiaire</ogc:Literal></ogc:PropertyIsEqualTo></ogc:Filter>
          <LineSymbolizer><Stroke><CssParameter name="stroke">#f2c230</CssParameter><CssParameter name="stroke-width">3.5</CssParameter></Stroke></LineSymbolizer>
        </Rule>
        <Rule>
          <Title>Route non classifiée</Title>
          <ogc:Filter><ogc:PropertyIsEqualTo><ogc:PropertyName>nature</ogc:PropertyName><ogc:Literal>Route non classifiée</ogc:Literal></ogc:PropertyIsEqualTo></ogc:Filter>
          <LineSymbolizer><Stroke><CssParameter name="stroke">#8d8d8d</CssParameter><CssParameter name="stroke-width">2.5</CssParameter></Stroke></LineSymbolizer>
        </Rule>
        <Rule>
          <Title>Route résidentielle</Title>
          <ogc:Filter><ogc:PropertyIsEqualTo><ogc:PropertyName>nature</ogc:PropertyName><ogc:Literal>Route résidentielle</ogc:Literal></ogc:PropertyIsEqualTo></ogc:Filter>
          <LineSymbolizer><Stroke><CssParameter name="stroke">#adb5bd</CssParameter><CssParameter name="stroke-width">2</CssParameter></Stroke></LineSymbolizer>
        </Rule>
        <Rule>
          <Title>Route d accès</Title>
          <ogc:Filter><ogc:PropertyIsEqualTo><ogc:PropertyName>nature</ogc:PropertyName><ogc:Literal>Route d accès</ogc:Literal></ogc:PropertyIsEqualTo></ogc:Filter>
          <LineSymbolizer><Stroke><CssParameter name="stroke">#ced4da</CssParameter><CssParameter name="stroke-width">1.5</CssParameter></Stroke></LineSymbolizer>
        </Rule>
        <Rule>
          <Title>Chemin carrossable</Title>
          <ogc:Filter><ogc:PropertyIsEqualTo><ogc:PropertyName>nature</ogc:PropertyName><ogc:Literal>Chemin carrossable</ogc:Literal></ogc:PropertyIsEqualTo></ogc:Filter>
          <LineSymbolizer><Stroke><CssParameter name="stroke">#a0785a</CssParameter><CssParameter name="stroke-width">1.5</CssParameter><CssParameter name="stroke-dasharray">4 3</CssParameter></Stroke></LineSymbolizer>
        </Rule>
        <Rule>
          <Title>Chemin non carrossable</Title>
          <ogc:Filter><ogc:PropertyIsEqualTo><ogc:PropertyName>nature</ogc:PropertyName><ogc:Literal>Chemin non carrossable</ogc:Literal></ogc:PropertyIsEqualTo></ogc:Filter>
          <LineSymbolizer><Stroke><CssParameter name="stroke">#a0785a</CssParameter><CssParameter name="stroke-width">1</CssParameter><CssParameter name="stroke-dasharray">2 3</CssParameter></Stroke></LineSymbolizer>
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>
