<?xml version="1.0" encoding="UTF-8"?>
<StyledLayerDescriptor version="1.0.0" xmlns="http://www.opengis.net/sld" xmlns:ogc="http://www.opengis.net/ogc"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.opengis.net/sld http://schemas.opengis.net/sld/1.0.0/StyledLayerDescriptor.xsd">
  <NamedLayer>
    <Name>labe_voies</Name>
    <UserStyle>
      <Title>Voies (adressage)</Title>
      <FeatureTypeStyle>
        <Rule>
          <Title>Nom officiel</Title>
          <ogc:Filter><ogc:PropertyIsEqualTo><ogc:PropertyName>statut_nom</ogc:PropertyName><ogc:Literal>Officiel</ogc:Literal></ogc:PropertyIsEqualTo></ogc:Filter>
          <LineSymbolizer><Stroke><CssParameter name="stroke">#1f6f43</CssParameter><CssParameter name="stroke-width">2</CssParameter></Stroke></LineSymbolizer>
        </Rule>
        <Rule>
          <Title>Code seul / nom d'usage</Title>
          <ElseFilter/>
          <LineSymbolizer><Stroke><CssParameter name="stroke">#7048e8</CssParameter><CssParameter name="stroke-width">1.5</CssParameter><CssParameter name="stroke-opacity">0.7</CssParameter></Stroke></LineSymbolizer>
        </Rule>
        <Rule>
          <MaxScaleDenominator>15000</MaxScaleDenominator>
          <TextSymbolizer>
            <Label><ogc:PropertyName>libelle</ogc:PropertyName></Label>
            <Font><CssParameter name="font-family">SansSerif</CssParameter><CssParameter name="font-size">10</CssParameter></Font>
            <LabelPlacement><LinePlacement><PerpendicularOffset>0</PerpendicularOffset></LinePlacement></LabelPlacement>
            <Halo><Radius>2</Radius><Fill><CssParameter name="fill">#ffffff</CssParameter></Fill></Halo>
            <Fill><CssParameter name="fill">#3b2a8a</CssParameter></Fill>
            <VendorOption name="followLine">true</VendorOption>
            <VendorOption name="repeat">300</VendorOption>
            <VendorOption name="group">yes</VendorOption>
          </TextSymbolizer>
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>
